// M1-7j (D-158 (5); 07 §3 `identity.prev_relays`, §4.3 "Leaving servers stay readable for 30 days";
// 04 §2.6): the servers that left the agent's own list and are still read.
//
// - Each change of the own list (a list change, a reset to automatic, "Update your contact
//   details") moves every server that leaves the list in, each with its own end: the change time
//   + LEAVING_SERVER_SECONDS. A server that is back in the new list leaves it. Entries whose end has
//   passed are pruned. There is no wait between changes.
// - At most MAX_LEAVING_SERVERS entries. A change that would need more is refused before anything is
//   signed (`too_many_previous`), with the earliest time from which it fits.
// - Reads use the own list, these servers and the legacy relays. Only card-updates are published here
//   (the owner `card-update`, and the own copies of the card-updates to contacts), never other
//   messages. While any entry runs, the owner `card-update` is re-published every 24 h.
// - Written only by the core: the rotation's commit transaction (identity.ts) and the pruning of the
//   sync pass. No MCP tool, tool argument or config value reaches it (I-4).
//
// I-7: logs carry counts only, never a server address.
import { canonicalize } from '@4thtech-io/crypto';
import { relayUrlSchema } from '@4thtech-io/types';
import { CoreError } from './errors.js';

/** How long a server that left the own list stays readable: 30 days (D-158 (5)). */
export const LEAVING_SERVER_SECONDS = 30 * 86_400;

/** At most this many leaving servers at once (07 §4.3 "Counts"; D-158 (5)). */
export const MAX_LEAVING_SERVERS = 16;

/** The owner `card-update` is re-published this often while any leaving server runs (07 §4.3). */
export const OWNER_CARD_UPDATE_OVERLAP_SECONDS = 86_400;

/** ...and this often otherwise (07 §4.3). */
export const OWNER_CARD_UPDATE_SECONDS = 7 * 86_400;

/** One server that left the own list, read until `until` (unix seconds, exclusive). */
export interface LeavingServer {
  readonly url: string;
  readonly until: number;
}

/**
 * A change that would keep more than MAX_LEAVING_SERVERS leaving servers (07 §4.3; D-158 (5)).
 * `fitsAt`: the unix second from which the same change fits, when enough entries have ended by then
 * (undefined if none would). Numbers only, never input (I-5, I-7).
 */
export class TooManyPreviousError extends CoreError {
  readonly fitsAt: number | undefined;

  constructor(fitsAt: number | undefined) {
    super(
      'too_many_previous',
      'Too many servers are still being read after earlier changes. Try again later.',
    );
    this.name = 'TooManyPreviousError';
    this.fitsAt = fitsAt;
  }
}

/** The entries still running at `now` (an entry ends at its `until`). */
export function runningLeaving(
  prev: readonly LeavingServer[],
  now: number,
): readonly LeavingServer[] {
  return Object.freeze(prev.filter((e) => e.until > now));
}

/**
 * The leaving servers after a change of the own list from `oldList` to `newList` at `now`: the
 * running entries, without any server that is in `newList`, plus every server of `oldList` that is
 * not in `newList`, each ending at now + LEAVING_SERVER_SECONDS. Throws TooManyPreviousError when
 * the result holds more than MAX_LEAVING_SERVERS entries. A change that keeps the list (a rename)
 * only prunes. `clamp` (the commit of a change already checked before signing, where a later time
 * can only end more entries): never throws, and keeps the entries that end last.
 */
export function nextLeaving(
  prev: readonly LeavingServer[],
  oldList: readonly string[],
  newList: readonly string[],
  now: number,
  clamp = false,
): readonly LeavingServer[] {
  const keep = new Set(newList);
  const until = now + LEAVING_SERVER_SECONDS;
  const kept = runningLeaving(prev, now).filter((e) => !keep.has(e.url));
  const byUrl = new Map<string, LeavingServer>(kept.map((e) => [e.url, e]));
  const leaving = oldList.filter((url) => !keep.has(url));
  for (const url of leaving) byUrl.set(url, { url, until });
  const out = [...byUrl.values()];
  if (out.length > MAX_LEAVING_SERVERS && clamp) {
    const last = [...out].sort((x, y) => y.until - x.until).slice(0, MAX_LEAVING_SERVERS);
    return Object.freeze(out.filter((e) => last.includes(e)));
  }
  if (out.length > MAX_LEAVING_SERVERS) {
    // The new entries end last, so the change fits once enough of the kept entries have ended.
    const needed = out.length - MAX_LEAVING_SERVERS;
    const ends = kept
      .filter((e) => !leaving.includes(e.url))
      .map((e) => e.until)
      .sort((a, b) => a - b);
    throw new TooManyPreviousError(needed <= ends.length ? ends[needed - 1] : undefined);
  }
  return Object.freeze(out);
}

/** The stored text of a list (canonical JSON), or null when it is empty (07 §3: null when empty). */
export function leavingText(prev: readonly LeavingServer[]): string | null {
  if (prev.length === 0) return null;
  return canonicalize(prev.map((e) => ({ url: e.url, until: e.until })));
}

/**
 * Parses a stored list. Fail closed: anything but at most MAX_LEAVING_SERVERS unique entries, each a
 * relay URL that passes the relay URL rule and a safe integer end, is unreadable.
 */
export function parseLeaving(text: string): readonly LeavingServer[] {
  const bad = (): CoreError =>
    new CoreError('store_unreadable', 'A stored value could not be read.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (!Array.isArray(value) || value.length > MAX_LEAVING_SERVERS) throw bad();
  const seen = new Set<string>();
  const out: LeavingServer[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw bad();
    const { url, until, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw bad();
    const parsed = relayUrlSchema.safeParse(url);
    if (!parsed.success || typeof until !== 'number' || !Number.isSafeInteger(until)) throw bad();
    if (until < 0 || seen.has(parsed.data)) throw bad();
    seen.add(parsed.data);
    out.push(Object.freeze({ url: parsed.data, until }));
  }
  return Object.freeze(out);
}

/** Two lists hold the same entries in the same order. */
export function sameLeaving(a: readonly LeavingServer[], b: readonly LeavingServer[]): boolean {
  return a.length === b.length && a.every((e, i) => e.url === b[i]?.url && e.until === b[i]?.until);
}
