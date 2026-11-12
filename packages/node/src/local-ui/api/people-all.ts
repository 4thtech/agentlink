// WP-P2 (design-1112 spec §5, third bullet; 08 §1; D-138; I-4, I-5, I-7): People across all IDs.
//
// - `GET /api/ui/people` (read, `presence: false`): every ID of this owner with its people, so the
//   People page shows one list with "with {ID}" on each row and an "All my IDs" filter. It signs
//   nothing, writes nothing and switches nothing: opening a person of another ID is the existing
//   switch route (api/agents.ts), run by the page.
//
// Each ID answers `{name, label, current, status: 'ok', contacts}` or, when its people cannot be
// read just now, `{name, label, current, status: 'unavailable'}` (no reason, no error text): that ID
// is missing from the list and the page says so in plain words. `name` is the folder name the switch
// route takes; `label` is the owner's own label (plain text, display only). A person's row is built
// by the one allowlist of api/contacts.ts (`contactRows`): never a card, a key, the raw name, a
// fingerprint beyond the short one, a path or an error's text. Names stay counterparty text (I-5):
// the page renders them as text only and they never reach an error or a log line.
//
// Outside the app host (an approval page opened by an MCP process) there is no desk: the read answers
// `{status: 'ok', switchable: false, ids: []}` and the page keeps its one-ID list.
//
// The desk (createPeopleAllDesk) reads the open ID through its own client and every other ID by
// opening it briefly through the host's open path (the CLI's openAgent: KeyStore, store, shared folder
// lock; no relay I/O for a contacts read) and closing it again. Other IDs' views are kept for
// `cacheMs` so the page's poll does not open them each time; one read runs at a time.
import type { ContactView } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiReadRoute, LocalUiRoute } from '../route-types.js';
import { UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';
import { contactRows } from './contacts.js';

export const PEOPLE_ALL_PATH = '/api/ui/people';

/** At most this many IDs are read (the Agents list's own bound is the same order). */
export const MAX_PEOPLE_IDS = 32;
/** How long another ID's people are reused before it is opened again. */
export const PEOPLE_CACHE_MS = 30_000;

/** One ID's part of the read; `contacts` undefined: it could not be read just now. */
export interface LocalUiPeopleOfId {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly contacts: readonly ContactView[] | undefined;
}

/** What the read route may call (built by the server over the app host). Reads only. */
export interface LocalUiPeopleAllDesk {
  list(): Promise<readonly LocalUiPeopleOfId[]>;
}

/** An ID as the host lists it (AgentDirectoryEntry's display fields). Never a path. */
export interface PeopleAllEntry {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
  readonly removing: boolean;
}

/** Another ID, opened for one read: its contacts and its close. */
export interface PeopleAllOpened {
  contacts(): Promise<readonly ContactView[]>;
  close(): Promise<void>;
}

export interface PeopleAllDeskDeps {
  /** The host's ID folders (directory.list). */
  entries(): Promise<readonly PeopleAllEntry[]>;
  /** The open ID's folder name and label; undefined when none is open. */
  current(): { readonly name: string; readonly label: string } | undefined;
  /** The open ID's contacts, through its own client. */
  currentContacts(): Promise<readonly ContactView[]>;
  /** Opens another ID for a read (the host's openNew); undefined when it cannot be opened. */
  open(name: string): Promise<PeopleAllOpened | undefined>;
  /** Milliseconds. */
  now(): number;
  readonly cacheMs?: number;
}

interface Cached {
  readonly at: number;
  readonly contacts: readonly ContactView[];
}

/** The desk the server puts in the app host's context. Never throws past `list`'s own rejection. */
export function createPeopleAllDesk(deps: PeopleAllDeskDeps): LocalUiPeopleAllDesk {
  const cacheMs = deps.cacheMs ?? PEOPLE_CACHE_MS;
  const cache = new Map<string, Cached>();
  let running: Promise<readonly LocalUiPeopleOfId[]> | undefined;

  const readOther = async (name: string): Promise<readonly ContactView[] | undefined> => {
    const kept = cache.get(name);
    if (kept !== undefined && deps.now() - kept.at < cacheMs) return kept.contacts;
    const opened = await deps.open(name).catch(() => undefined);
    if (opened === undefined) return undefined;
    try {
      const contacts = await opened.contacts();
      cache.set(name, { at: deps.now(), contacts });
      return contacts;
    } catch {
      return undefined;
    } finally {
      await opened.close().catch(() => undefined);
    }
  };

  const read = async (): Promise<readonly LocalUiPeopleOfId[]> => {
    const entries = (await deps.entries()).slice(0, MAX_PEOPLE_IDS);
    const open = deps.current();
    const out: LocalUiPeopleOfId[] = [];
    for (const entry of entries) {
      if (entry.removing) continue;
      const current = entry.name === open?.name;
      let contacts: readonly ContactView[] | undefined;
      if (current) {
        contacts = await deps.currentContacts().catch(() => undefined);
        // Kept for after a switch away from it, so the list does not flicker.
        if (contacts !== undefined) cache.set(entry.name, { at: deps.now(), contacts });
      } else {
        contacts = entry.available ? await readOther(entry.name) : undefined;
      }
      out.push(
        Object.freeze({
          name: entry.name,
          label: current ? (open?.label ?? entry.label) : entry.label,
          current,
          contacts,
        }),
      );
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of [...cache.keys()]) if (!names.has(name)) cache.delete(name);
    return Object.freeze(out);
  };

  return Object.freeze<LocalUiPeopleAllDesk>({
    list: () => {
      running ??= read().finally(() => {
        running = undefined;
      });
      return running;
    },
  });
}

/** The 06 §6 agent-name rule: a part with another name is left out. */
const ID_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_LABEL_CHARS = 128;

function idPart(part: LocalUiPeopleOfId): JsonObject | undefined {
  if (!ID_NAME.test(part.name)) return undefined;
  const label =
    typeof part.label === 'string' && part.label.length > 0 && part.label.length <= MAX_LABEL_CHARS
      ? part.label
      : part.name;
  const head = { name: part.name, label, current: part.current === true };
  if (part.contacts === undefined) return { ...head, status: 'unavailable' };
  return { ...head, status: 'ok', contacts: contactRows(part.contacts) };
}

const listRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: PEOPLE_ALL_PATH,
  presence: false,
  handler: async (context, request) => {
    // No query parameter is defined: anything sent is refused, never echoed.
    if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
    const desk = context.peopleAll;
    if (desk === undefined) {
      return { status: 200, body: { status: 'ok', switchable: false, ids: [] } };
    }
    try {
      const ids: JsonObject[] = [];
      for (const part of await desk.list()) {
        const out = idPart(part);
        if (out !== undefined) ids.push(out);
      }
      return { status: 200, body: { status: 'ok', switchable: true, ids } };
    } catch {
      // Never the error's text: it could name a path or a person.
      return UI_UNAVAILABLE;
    }
  },
});

export const peopleAllRoutes: readonly LocalUiRoute[] = Object.freeze([listRoute]);
