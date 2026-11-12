// REL051-RET1 (retention plan RET-1; 08 §1 Storage; 04 §2.5, §4; D-118, D-138; I-4, I-5, I-7): the
// read-only Storage view in Settings.
//
// - `GET /api/ui/storage` (read, `presence: false`): how much room each ID's messages and saved
//   files take, per person for the open ID, and the Inbox folder. It signs nothing, writes nothing,
//   deletes nothing and switches nothing; the gates are the ones of every read route (session cookie,
//   CSRF header, fetch metadata). Not an MCP tool (I-4).
//
// Every answer is built field by field. Sizes are whole numbers of bytes and counts; names are the
// restricted display names core gives (I-5: the page renders them as text); the Inbox folder is the
// owner's own setting with the home folder shown as `~` (08 §1), never a resolved path. Never a
// contact ID, file name, link, key or error text (I-7). One ID's store is read at a time through
// the read-only peek (node storage-usage.ts); another ID's people are sealed in its own store, so for
// it the view answers its totals only ("Open it to see people"): no other KeyStore, client or store is
// opened (04 §2.5). A switch during the read drops the open ID's rows (never one ID's people shown
// under another). One read runs at a time and gives up after `timeoutMs` (the route answers 503).
//
// Outside the app host (an approval page opened by an MCP process) there is no desk: the read answers
// `{status: 'ok', switchable: false, ids: [], inbox: null}`.
import { homedir } from 'node:os';
import type { ContactView } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { resolveInboxFolder } from '../../allowed-path.js';
import { scanInbox, type InboxScan, type StorageUsage } from '../../storage-usage.js';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiRoute } from '../route-types.js';
import { UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';
import { displayFolder } from './files-io.js';

export const STORAGE_PATH = '/api/ui/storage';

/** At most this many IDs and people are answered. */
export const MAX_STORAGE_IDS = 32;
export const MAX_STORAGE_PEOPLE = 500;
/** A read that takes longer is given up (the route answers 503). */
export const STORAGE_READ_TIMEOUT_MS = 8_000;

export interface StorageOpenId {
  readonly name: string;
  readonly label: string;
  readonly generation: number;
  /** The open ID's people through the client captured with it. */
  contacts(): Promise<readonly ContactView[]>;
  /** The open ID's weekly drop use (numbers only); undefined when not known. */
  dropUsage?(): Promise<{ readonly usedBytes: number; readonly quotaBytes: number } | undefined>;
}

export interface StorageEntry {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
  readonly removing: boolean;
}

export interface StorageInbox {
  /** The Inbox folder setting, home shown as `~`. */
  readonly folder: string;
  readonly scan: InboxScan;
}

/** What the read route may call (built by the server over the app host). Reads only. */
export interface LocalUiStorageDesk {
  list(): Promise<LocalUiStorageRead>;
}

export interface LocalUiStorageIdPart {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  /** Undefined: could not be read just now. */
  readonly usage: StorageUsage | undefined;
  /** The open ID only: its people (restricted display names), undefined when not readable. */
  readonly people?: readonly ContactView[] | undefined;
  readonly drop?: { readonly usedBytes: number; readonly quotaBytes: number } | undefined;
}

export interface LocalUiStorageRead {
  readonly ids: readonly LocalUiStorageIdPart[];
  readonly inbox: StorageInbox | undefined;
}

export interface StorageDeskDeps {
  entries(): Promise<readonly StorageEntry[]>;
  open(): StorageOpenId | undefined;
  generation(): number;
  /** One ID's store sizes (directory.storage); undefined when it cannot be read. */
  usage(name: string): Promise<StorageUsage | undefined>;
  inbox(): Promise<StorageInbox | undefined>;
  readonly timeoutMs?: number;
}

/** The Inbox folder of the rules in force, measured. Undefined when unknown or unreadable. */
export async function inboxUsageOf(
  client: LocalUiReadClient | undefined,
  home: string = homedir(),
): Promise<StorageInbox | undefined> {
  if (client === undefined || (client as Partial<LocalUiReadClient>).policy === undefined) {
    return undefined;
  }
  try {
    const policy = await client.policy.load();
    if (policy.mode === 'fail_closed') return undefined;
    const setting = (policy.policy.files as { inboxFolder?: unknown } | undefined)?.inboxFolder;
    if (typeof setting !== 'string' || setting.length === 0) return undefined;
    const resolved = await resolveInboxFolder(setting, { home });
    const scan = await scanInbox(resolved.folder);
    return scan === undefined ? undefined : { folder: displayFolder(setting, home), scan };
  } catch {
    return undefined;
  }
}

/** The desk the server puts in the app host's context. */
export function createStorageDesk(deps: StorageDeskDeps): LocalUiStorageDesk {
  const timeoutMs = deps.timeoutMs ?? STORAGE_READ_TIMEOUT_MS;
  let running: Promise<LocalUiStorageRead> | undefined;

  const read = async (): Promise<LocalUiStorageRead> => {
    const open = deps.open();
    const startGeneration = deps.generation();
    const entries = (await deps.entries()).slice(0, MAX_STORAGE_IDS);
    const out: LocalUiStorageIdPart[] = [];
    for (const entry of entries) {
      if (entry.removing) continue;
      if (entry.name === open?.name) {
        const usage = await deps.usage(entry.name).catch(() => undefined);
        let people: readonly ContactView[] | undefined = await open
          .contacts()
          .catch(() => undefined);
        const drop = await (open.dropUsage?.() ?? Promise.resolve(undefined)).catch(
          () => undefined,
        );
        // A switch during the read: these rows may belong to another ID now; never show them.
        if (deps.generation() !== open.generation) people = undefined;
        out.push(
          Object.freeze({
            name: entry.name,
            label: open.label,
            current: true,
            usage,
            people,
            drop,
          }),
        );
        continue;
      }
      const usage = entry.available
        ? await deps.usage(entry.name).catch(() => undefined)
        : undefined;
      out.push(Object.freeze({ name: entry.name, label: entry.label, current: false, usage }));
    }
    // A switch during the read: the Inbox read may follow another ID's rules; drop it.
    const found = await deps.inbox().catch(() => undefined);
    const inbox = deps.generation() === startGeneration ? found : undefined;
    return Object.freeze({ ids: Object.freeze(out), inbox });
  };

  // One underlying read at a time: a read that outlives its time limit keeps running, and the next
  // call waits on it (with its own limit) instead of starting another.
  const timed = (inner: Promise<LocalUiStorageRead>): Promise<LocalUiStorageRead> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      inner.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('failed'));
        },
      );
    });

  return Object.freeze<LocalUiStorageDesk>({
    list: () => {
      running ??= read().finally(() => {
        running = undefined;
      });
      return timed(running);
    },
  });
}

/** The 06 §6 agent-name rule: a part with another name is left out. */
const ID_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME_CHARS = 128;
/** 2^53 - 1 is the store's own bound for an integer (07 §3.1). */
const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const n = (v: unknown): number => (whole(v) ? v : 0);

interface Sizes {
  messageBytes: number;
  fileCount: number;
  fileBytes: number;
}

const sizesOf = (s: Sizes): Sizes => ({
  messageBytes: n(s.messageBytes),
  fileCount: n(s.fileCount),
  fileBytes: n(s.fileBytes),
});

function peopleRows(
  usage: StorageUsage,
  people: readonly ContactView[],
): { readonly people: JsonObject[]; readonly other: Sizes } {
  const nameOf = new Map<string, string>();
  for (const view of people.slice(0, MAX_STORAGE_PEOPLE)) {
    const name: unknown = view.display?.name;
    if (typeof view.id === 'string' && typeof name === 'string' && name.length <= MAX_NAME_CHARS) {
      nameOf.set(view.id, name);
    }
  }
  const rows: JsonObject[] = [];
  const other: Sizes = { messageBytes: 0, fileCount: 0, fileBytes: 0 };
  for (const entry of usage.perContact) {
    const name = entry.contactId === null ? undefined : nameOf.get(entry.contactId);
    if (name === undefined) {
      // No contact, or a person who is no longer in the list: counted, never named.
      other.messageBytes += n(entry.messageBytes);
      other.fileCount += n(entry.fileCount);
      other.fileBytes += n(entry.fileBytes);
      continue;
    }
    rows.push({ name, ...sizesOf(entry) });
  }
  rows.sort(
    (a, b) => n(b['messageBytes']) + n(b['fileBytes']) - (n(a['messageBytes']) + n(a['fileBytes'])),
  );
  return { people: rows, other };
}

function idPart(part: LocalUiStorageIdPart): JsonObject | undefined {
  if (!ID_NAME.test(part.name)) return undefined;
  const label =
    typeof part.label === 'string' && part.label.length > 0 && part.label.length <= MAX_NAME_CHARS
      ? part.label
      : part.name;
  const head = { name: part.name, label, current: part.current };
  const { usage } = part;
  if (usage === undefined) return { ...head, status: 'unavailable' };
  const drop = part.current ? part.drop : undefined;
  const rows =
    part.current && part.people !== undefined ? peopleRows(usage, part.people) : undefined;
  return {
    ...head,
    status: 'ok',
    storeBytes: n(usage.storeBytes),
    walBytes: n(usage.walBytes),
    ...sizesOf(usage),
    ...(drop !== undefined && whole(drop.usedBytes) && whole(drop.quotaBytes)
      ? { drop: { usedBytes: drop.usedBytes, quotaBytes: drop.quotaBytes } }
      : {}),
    ...(rows === undefined ? {} : { people: rows.people, other: { ...rows.other } }),
  };
}

function inboxPart(inbox: StorageInbox | undefined): JsonObject | null {
  if (inbox === undefined) return null;
  const { folder, scan } = inbox;
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 512) return null;
  return {
    folder,
    files: n(scan.files),
    bytes: n(scan.bytes),
    truncated: scan.truncated === true,
  };
}

const listRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: STORAGE_PATH,
  presence: false,
  handler: async (context: LocalUiContext, request) => {
    // No query parameter is defined: anything sent is refused, never echoed.
    if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
    const desk = context.storage;
    if (desk === undefined) {
      return { status: 200, body: { status: 'ok', switchable: false, ids: [], inbox: null } };
    }
    try {
      const read = await desk.list();
      const ids: JsonObject[] = [];
      for (const part of read.ids) {
        const out = idPart(part);
        if (out !== undefined) ids.push(out);
      }
      return {
        status: 200,
        body: { status: 'ok', switchable: true, ids, inbox: inboxPart(read.inbox) },
      };
    } catch {
      // Never the error's text: it could name a path or a person.
      return UI_UNAVAILABLE;
    }
  },
});

export const storageRoutes: readonly LocalUiRoute[] = Object.freeze([listRoute]);
