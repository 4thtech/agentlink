// TRAY-PIPE (D-155; 08 §8; I-5, I-7; S2): what the desktop app's icon shows, as fixed words, counts
// and booleans (protocol.ts `tray-state`, `tray-pulse`, `shell-prefs`). Pure: the host (host-core.ts)
// feeds it the same look as the N7 alerts (alerts.ts) on each tick: the IDs of the approvals waiting,
// the open ID's notification items (kind, ref, count, times; never content), the newest time this
// ID's AI sent a message, and the link word from the health state.
//
// - State: the link word, unread = the unread messages and files items' counts, approvals = how many
//   wait. Never a ref, a name or an ID: the refs and approval IDs stay in the baseline, in memory.
// - Pulses, independent of the notification switches:
//   * `message_in`: a messages or files item that is new, grew or came back unread (N7's rule);
//   * `approval`: a waiting approval ID that was not at the last look (one decided and another
//     raised within one tick is still news);
//   * `ai_sent`: a newer outbound message time than any seen before (only messages this ID sent:
//     never a receipt, an ack or a message in).
// - A first look at an ID (start, or another ID opened) only notes what is there: it never pulses
//   (plan risk 3). The caller keeps the baseline when a look fails.
// - The gate lets at most one pulse per kind through per TRAY_PULSE_GAP_MS; more are dropped
//   (coalesced into the one already shown).
import type { NotificationItem } from '@4thtech-io/types/ui-contract/notifications';
import type { UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import {
  SHELL_MOTIONS,
  TRAY_PULSE_KINDS,
  type ShellMotion,
  type TrayLink,
  type TrayPulseKind,
} from './protocol.js';

/** At most one pulse per kind this often (08 §8). */
export const TRAY_PULSE_GAP_MS = 2_000;

/** The largest count on the pipe (protocol.ts isCount). */
const MAX_COUNT = 1_000_000;

/** One look at the open ID (in memory only). */
export interface TrayLook {
  /** Which ID this is (a change starts a fresh first look). */
  readonly scope: string;
  /** The IDs of the approvals waiting. */
  readonly approvals: readonly string[];
  readonly items: readonly NotificationItem[];
  /** The newest message this ID sent (unix seconds); null for none; undefined when unknown. */
  readonly outAt: number | null | undefined;
  readonly link: TrayLink;
}

export interface TrayStateView {
  readonly link: TrayLink;
  readonly unread: number;
  readonly approvals: number;
}

export interface ShellPrefsView {
  readonly menuBarIcon: boolean;
  readonly motion: ShellMotion;
}

export interface TrayBaseline {
  readonly scope: string;
  readonly approvals: ReadonlySet<string>;
  readonly inbound: ReadonlyMap<string, { count: number; at: number; read: boolean }>;
  /** The newest outbound time seen so far (never goes back); null before any. */
  readonly outAt: number | null;
}

const isInbound = (item: NotificationItem): boolean =>
  item.kind === 'messages' || item.kind === 'files';

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The icon's state for one look: a word and two counts. */
export function trayStateOf(look: TrayLook): TrayStateView {
  let unread = 0;
  for (const item of look.items) {
    if (!isInbound(item) || item.read) continue;
    const count = Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0;
    unread = Math.min(MAX_COUNT, unread + count);
  }
  return Object.freeze({
    link: look.link,
    unread,
    approvals: Math.min(MAX_COUNT, look.approvals.length),
  });
}

/** The pulses since `prev`, the next baseline and the state. */
export function planTray(
  prev: TrayBaseline | undefined,
  look: TrayLook,
): {
  readonly pulses: readonly TrayPulseKind[];
  readonly baseline: TrayBaseline;
  readonly state: TrayStateView;
} {
  const first = prev === undefined || prev.scope !== look.scope;
  const seenOut = first ? null : prev.outAt;
  const out = isTime(look.outAt) ? look.outAt : undefined;
  const baseline: TrayBaseline = Object.freeze({
    scope: look.scope,
    approvals: new Set(look.approvals),
    inbound: new Map(
      look.items
        .filter(isInbound)
        .map((i) => [i.id, { count: i.count, at: i.at, read: i.read }] as const),
    ),
    outAt: out === undefined ? seenOut : seenOut === null ? out : Math.max(seenOut, out),
  });
  const state = trayStateOf(look);
  if (first) return { pulses: [], baseline, state };
  const pulses = new Set<TrayPulseKind>();
  if (look.approvals.some((id) => !prev.approvals.has(id))) pulses.add('approval');
  for (const item of look.items) {
    if (!isInbound(item) || item.read) continue;
    const before = prev.inbound.get(item.id);
    if (before === undefined || before.read || item.count > before.count || item.at > before.at) {
      pulses.add('message_in');
      break;
    }
  }
  if (out !== undefined && (prev.outAt === null || out > prev.outAt)) pulses.add('ai_sent');
  return { pulses: TRAY_PULSE_KINDS.filter((k) => pulses.has(k)), baseline, state };
}

/** The 2 s gate per kind (a clock going back keeps it shut until the gap passed again). */
export function createPulseGate(gapMs = TRAY_PULSE_GAP_MS): {
  pass(kinds: readonly TrayPulseKind[], nowMs: number): TrayPulseKind[];
} {
  const last = new Map<TrayPulseKind, number>();
  return {
    pass: (kinds, nowMs) => {
      const out: TrayPulseKind[] = [];
      for (const kind of kinds) {
        if (out.includes(kind)) continue;
        const at = last.get(kind);
        if (at !== undefined && nowMs < at + gapMs) {
          // Never let a clock that went back open the gate early.
          if (nowMs < at) last.set(kind, nowMs);
          continue;
        }
        last.set(kind, nowMs);
        out.push(kind);
      }
      return out;
    },
  };
}

/** The motion the Appearance page keeps (`agentlink.prefs`), or system for anything else. */
function motionOf(raw: string | null | undefined): ShellMotion {
  if (typeof raw !== 'string' || raw.length > 256) return 'system';
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return 'system';
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'system';
  const motion = (data as { motion?: unknown }).motion;
  return typeof motion === 'string' && (SHELL_MOTIONS as readonly string[]).includes(motion)
    ? (motion as ShellMotion)
    : 'system';
}

/** The shell's two switches from the UI settings (absent = on, motion system). */
export function shellPrefsOf(settings: UiSettings | undefined): ShellPrefsView {
  return Object.freeze({
    menuBarIcon: settings?.menuBarIcon !== false,
    motion: motionOf(settings?.kept?.['agentlink.prefs']),
  });
}
