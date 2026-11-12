// WP-P2 (design-1112 spec §5, third bullet; 08 §1; 04 §2.5; D-138; I-4, I-5, I-7): People across all
// IDs.
//
// - `GET /api/ui/people` (read, `presence: false`): every ID of this owner, so the People page shows
//   "with {ID}" on each row and an "All my IDs" filter. It signs nothing, writes nothing and switches
//   nothing: opening another ID is the existing switch route (api/agents.ts), run by the page.
//
// 04 §2.5: at most one agent's KeyStore and store are open in the host. Another ID's people names are
// sealed in its store (07 §3), so this read never opens another ID's KeyStore, client or store for
// writing: for another ID it answers only the count of its active people, from the same read-only
// peek the Agents list uses (directory `stats`, node agent-peek.ts: SQLITE_OPEN_READONLY, clear
// columns only, no lock, no keys, no migration, nothing written). The page shows "{n} people with
// {ID}" and "Open {ID}" (the switch). The open ID's people come from its own client, as rows built by
// the one allowlist of api/contacts.ts (`contactRows`).
//
// Each ID answers `{name, label, current, status: 'ok', contacts | count}` or, when it cannot be read
// just now, `{name, label, current, status: 'unavailable'}` (no reason, no error text). `name` is the
// folder name the switch route takes; `label` is the owner's own label (plain text, display only).
// Names stay counterparty text (I-5): the page renders them as text only; they never reach an error
// or a log line.
//
// The open ID and its client are captured together with the host generation; when the generation
// changed by the time the rows are read (a switch in between), the rows are dropped (that ID answers
// `unavailable`), so one ID's people are never shown "with" another. One read runs at a time and gives
// up after `timeoutMs` (the route then answers 503), so a stuck read never pins the route.
//
// Outside the app host (an approval page opened by an MCP process) there is no desk: the read answers
// `{status: 'ok', switchable: false, ids: []}` and the page keeps its one-ID list.
import type { ContactView } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiReadRoute, LocalUiRoute } from '../route-types.js';
import { UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';
import { contactRows } from './contacts.js';

export const PEOPLE_ALL_PATH = '/api/ui/people';

/** At most this many IDs are read. */
export const MAX_PEOPLE_IDS = 32;
/** A read that takes longer is given up (the route answers 503). */
export const PEOPLE_READ_TIMEOUT_MS = 5_000;

/** One ID's part of the read. */
export type LocalUiPeopleOfId =
  | {
      readonly name: string;
      readonly label: string;
      readonly current: true;
      /** Undefined: could not be read just now (or a switch happened during the read). */
      readonly contacts: readonly ContactView[] | undefined;
    }
  | {
      readonly name: string;
      readonly label: string;
      readonly current: false;
      /** Active people (the store peek); undefined when the store cannot be read just now. */
      readonly count: number | undefined;
    };

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

/** The open ID as captured in one synchronous step: its name, label, client read and generation. */
export interface PeopleAllOpen {
  readonly name: string;
  readonly label: string;
  readonly generation: number;
  /** The open ID's contacts through the client captured with it. */
  contacts(): Promise<readonly ContactView[]>;
}

export interface PeopleAllDeskDeps {
  /** The host's ID folders (directory.list). */
  entries(): Promise<readonly PeopleAllEntry[]>;
  /** The open ID, captured atomically; undefined when none is open. */
  open(): PeopleAllOpen | undefined;
  /** The host's generation now (a switch increases it). */
  generation(): number;
  /**
   * Another ID's active people count, from the read-only store peek (directory.stats); undefined
   * when it cannot be read. Never opens a KeyStore or a client.
   */
  count(name: string): Promise<number | undefined>;
  readonly timeoutMs?: number;
}

/** The desk the server puts in the app host's context. */
export function createPeopleAllDesk(deps: PeopleAllDeskDeps): LocalUiPeopleAllDesk {
  const timeoutMs = deps.timeoutMs ?? PEOPLE_READ_TIMEOUT_MS;
  let running: Promise<readonly LocalUiPeopleOfId[]> | undefined;

  const read = async (): Promise<readonly LocalUiPeopleOfId[]> => {
    const open = deps.open();
    const entries = (await deps.entries()).slice(0, MAX_PEOPLE_IDS);
    let own: readonly ContactView[] | undefined;
    if (open !== undefined) {
      own = await open.contacts().catch(() => undefined);
      // A switch during the read: these rows may belong to another ID now; never show them.
      if (deps.generation() !== open.generation) own = undefined;
    }
    const out: LocalUiPeopleOfId[] = [];
    for (const entry of entries) {
      if (entry.removing) continue;
      if (entry.name === open?.name) {
        out.push(
          Object.freeze({ name: entry.name, label: open.label, current: true, contacts: own }),
        );
        continue;
      }
      const count = entry.available
        ? await deps.count(entry.name).catch(() => undefined)
        : undefined;
      out.push(Object.freeze({ name: entry.name, label: entry.label, current: false, count }));
    }
    return Object.freeze(out);
  };

  const timed = (): Promise<readonly LocalUiPeopleOfId[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      read().then(
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

  return Object.freeze<LocalUiPeopleAllDesk>({
    list: () => {
      running ??= timed().finally(() => {
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
  if (part.current) {
    const head = { name: part.name, label, current: true };
    if (part.contacts === undefined) return { ...head, status: 'unavailable' };
    return { ...head, status: 'ok', contacts: contactRows(part.contacts) };
  }
  const head = { name: part.name, label, current: false };
  const { count } = part;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    return { ...head, status: 'unavailable' };
  }
  return { ...head, status: 'ok', count };
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
