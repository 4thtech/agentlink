// NOTIFY-ALL-IDS (S2; I-5, I-7; 04 §2.5): while the desktop app alerts for ONE ID (it holds only that
// ID's keys open), a new message or file for any other ID still raises an OS alert. The `agentlink
// mcp` process of that other ID already holds its keys and store, so this reads nothing more than
// that process may: the flow events (contact ID, direction, kind, time; no text, no file name) and
// the names the OWNER gave. No key, store or ID is opened for it.
//
// - First look of a run, or after a pause: only notes what is there (nothing old is alerted).
// - News: an inbound event not seen before, counted per person; a file and its message from one
//   person in one look are ONE alert (the file's).
// - The owner's switches decide (Settings > Notifications, read on every look): Messages, Files. A
//   name only with Show names on, and only in the pipe's plain name shape (protocol.ts
//   `isNotifyName`): the ID's folder name and a contact name the owner gave. A counterparty's own
//   (self-declared) name, message text, a file name or a link never reach the alert text (I-5).
// - Quiet while the desktop app alerts for THIS ID (it shows its own notification) and while no
//   desktop app runs (then nothing here changes for the CLI and browser app).
// - Nothing is logged; a failed look keeps its place and alerts nothing.
import type { NotifyPrefKey } from '@4thtech-io/types/ui-contract/notifications';
import { dedupeFileAndMessage, type RecentAlerts } from '../desktop/alert-dedupe.js';
import { isNotifyName } from '../desktop/protocol.js';

/** One flow event as this module reads it (the core's FlowEvent without its state). */
export interface OtherIdEvent {
  readonly contactId: string;
  readonly direction: 'in' | 'out';
  readonly kind: 'message' | 'file';
  /** Unix seconds. */
  readonly at: number;
}

export interface OtherIdLook {
  /** Unix seconds: when the last look ended. */
  readonly cursor: number;
  /** The events of the overlap already counted (`<m|f><contact>:<at>:<n>`). */
  readonly seen: ReadonlySet<string>;
}

export interface OtherIdNews {
  readonly kind: 'messages' | 'files';
  readonly count: number;
  readonly ref: string;
}

/** A look starts this many seconds before the last one ended (a message stored late is still seen). */
export const OTHER_ID_OVERLAP_SECONDS = 30;
/** How often a look is made. */
export const OTHER_ID_LOOK_MS = 30_000;
const MAX_COUNT = 1_000_000;
const REF = /^0x[0-9a-f]{40}$/;

type Prefs = Readonly<Record<NotifyPrefKey, boolean>>;

/** News since `prev` (none on the first look), and the next look. */
export function planOtherIdAlerts(
  prev: OtherIdLook | undefined,
  events: readonly OtherIdEvent[],
  nowSeconds: number,
): { readonly news: readonly OtherIdNews[]; readonly look: OtherIdLook } {
  const keep = new Set<string>();
  const equal = new Map<string, number>();
  const fresh: OtherIdEvent[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.direction !== 'in' || !REF.test(e.contactId)) continue;
    if (e.kind !== 'message' && e.kind !== 'file') continue;
    const base = `${e.kind === 'file' ? 'f' : 'm'}${e.contactId}:${String(e.at)}`;
    const n = equal.get(base) ?? 0;
    equal.set(base, n + 1);
    const key = `${base}:${String(n)}`;
    keep.add(key);
    if (
      prev !== undefined &&
      !prev.seen.has(key) &&
      e.at >= prev.cursor - OTHER_ID_OVERLAP_SECONDS
    ) {
      fresh.push(e);
    }
  }
  const look: OtherIdLook = Object.freeze({ cursor: nowSeconds, seen: keep });
  if (prev === undefined) return { news: [], look };
  const byRef = new Map<string, { messages: number; files: number }>();
  for (const e of fresh) {
    const entry = byRef.get(e.contactId) ?? { messages: 0, files: 0 };
    if (e.kind === 'file') entry.files += 1;
    else entry.messages += 1;
    byRef.set(e.contactId, entry);
  }
  const news: OtherIdNews[] = [];
  for (const [ref, c] of byRef) {
    // NOTIFY-DEDUPE: a file and its message are one alert, the file's.
    if (c.files > 0) news.push({ kind: 'files', count: c.files, ref });
    else if (c.messages > 0) news.push({ kind: 'messages', count: c.messages, ref });
  }
  return { news, look };
}

const TITLES = { messages: 'New message', files: 'File received' } as const;

/** The `[title, body]` lines for this news under these switches: fixed words, local names only. */
export function otherIdLines(
  news: readonly OtherIdNews[],
  prefs: Prefs,
  idName: string,
  names: ReadonlyMap<string, string>,
): (readonly [title: string, body: string])[] {
  const out: (readonly [string, string])[] = [];
  const named = prefs.showNames && isNotifyName(idName);
  for (const n of news) {
    if (!prefs[n.kind === 'files' ? 'files' : 'messages']) continue;
    const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(n.count)));
    const many = count > 1;
    const what = n.kind === 'files' ? (many ? 'files' : 'file') : many ? 'messages' : 'message';
    if (!named) {
      const lead = many ? `There are ${String(count)} new` : 'There is a new';
      out.push([TITLES[n.kind], `${lead} ${what} for another one of your IDs.`]);
      continue;
    }
    const contact = names.get(n.ref);
    const from = isNotifyName(contact) ? ` from ${contact}` : '';
    out.push([
      TITLES[n.kind],
      `${many ? `${String(count)} new ${what}` : `New ${what}`} for ${idName}${from}.`,
    ]);
  }
  return out;
}

export interface OtherIdAlertsDeps {
  /** This process's ID (an agent folder name). */
  readonly agentName: string;
  /** The ID the running desktop app alerts for; undefined when none runs. */
  readonly desktopOwner: () => Promise<string | undefined>;
  /** The switches in force (read on each look). */
  readonly prefs: () => Promise<Prefs>;
  /** This ID's flow events in a window (unix seconds), through the client this process holds. */
  readonly events: (
    since: number,
    until: number,
  ) => Promise<{ readonly events: readonly OtherIdEvent[]; readonly capped: boolean }>;
  /** The names the OWNER gave these contacts of this ID (never a self-declared one). */
  readonly ownerNames: (refs: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /** The OS notification (osascript / notify-send). */
  readonly notify: (lines: readonly [title: string, body: string]) => Promise<boolean>;
  /** Unix seconds. */
  readonly now: () => number;
}

export interface OtherIdAlerts {
  /** One look (tests; the timer calls it). Never rejects. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createOtherIdAlerts(deps: OtherIdAlertsDeps): OtherIdAlerts {
  let look: OtherIdLook | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  /** NOTIFY-DEDUPE: across looks, a person's file and its message are one alert. */
  const recent: RecentAlerts = new Map();
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const owner = await deps.desktopOwner();
      // Quiet while the desktop app alerts for this ID, or none runs: the next time it does, a
      // fresh first look (no backfill).
      if (owner === undefined || owner === deps.agentName) {
        look = undefined;
        return;
      }
      const prefs = await deps.prefs();
      if (!prefs.messages && !prefs.files) {
        look = undefined;
        return;
      }
      const now = deps.now();
      const since = Math.max(0, (look?.cursor ?? now) - OTHER_ID_OVERLAP_SECONDS);
      const read = await deps.events(since, now);
      const plan = planOtherIdAlerts(look, read.events, now);
      look = plan.look;
      if (plan.news.length === 0) return;
      const news = dedupeFileAndMessage(
        plan.news,
        (kind) => prefs[kind === 'files' ? 'files' : 'messages'],
        recent,
        deps.now() * 1000,
      );
      const refs = prefs.showNames ? [...new Set(news.map((n) => n.ref))] : [];
      const names = refs.length === 0 ? new Map<string, string>() : await deps.ownerNames(refs);
      for (const line of otherIdLines(news, prefs, deps.agentName, names)) {
        await deps.notify(line).catch(() => false);
      }
    } catch {
      // A failed look keeps its place and alerts nothing.
    } finally {
      running = false;
    }
  };
  return {
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void tick(), OTHER_ID_LOOK_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
