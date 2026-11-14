// N7 (PLAN-NOTIFY §3.5; D2; S2): what the desktop core asks the shell to alert about, as fixed codes
// (protocol.ts `notify {kind, count, name}`). Pure: the host (host-core.ts) feeds it the IDs of the
// approvals waiting and the open ID's notification items (kind, ref, count, times; never content) on
// each tick.
//
// - The first look at an ID (start, or another ID opened) only notes what is there: nothing that was
//   already waiting is alerted (the window opens on Home anyway).
// - News: an approval waiting that was not at the last look, by its ID, so one decided and another
//   raised within one tick is still news (IR-N7-1 L-3); the count is the number waiting. A person's messages or
//   files item that is new, grew or came back unread (how many are new); an update that became ready.
// - The owner's switches decide (Settings › Notifications; D2: approvals on, the rest off). A name
//   only with Show names on, only from the owner-given names the server answered (nameSource
//   'owner'), and only in the pipe's plain name shape; otherwise "".
import type { NotificationItem, NotifyPrefKey } from '@4thtech-io/types/ui-contract/notifications';
import { isNotifyName, isNotifyTarget, type NotifyKind, type NotifyMessage } from './protocol.js';

/** The open ID's alert inputs (ApprovalServer.desktopAlerts). */
export interface AlertSource {
  /** Which ID this is (in memory only; a change starts a fresh first look). */
  readonly scope: string;
  readonly items: readonly NotificationItem[];
  readonly prefs: Readonly<Record<NotifyPrefKey, boolean>>;
}

export interface AlertBaseline {
  readonly scope: string;
  /** The approvals waiting at the last look, by ID. */
  readonly approvals: ReadonlySet<string>;
  readonly items: ReadonlyMap<string, { count: number; at: number; read: boolean }>;
}

export interface AlertNews {
  readonly kind: NotifyKind;
  readonly count: number;
  /** A contact's ID (messages, files): for the owner-name lookup only, never on the pipe. */
  readonly ref?: string;
  /** NOTIFY-DEEPLINK: the one approval that is news, when it is the only one waiting. */
  readonly approvalId?: string;
}

const MAX_COUNT = 1_000_000;

function baselineOf(
  scope: string,
  approvals: readonly string[],
  items: readonly NotificationItem[],
): AlertBaseline {
  return Object.freeze({
    scope,
    approvals: new Set(approvals),
    items: new Map(items.map((i) => [i.id, { count: i.count, at: i.at, read: i.read }])),
  });
}

/**
 * News since `prev`, and the next baseline. The caller keeps `prev` when a look fails (never resets
 * it), so a failed look never makes an approval that arrives meanwhile count as already there.
 */
export function planAlerts(
  prev: AlertBaseline | undefined,
  approvals: readonly string[],
  source: AlertSource,
): { readonly news: readonly AlertNews[]; readonly baseline: AlertBaseline } {
  const baseline = baselineOf(source.scope, approvals, source.items);
  if (prev === undefined || prev.scope !== source.scope) return { news: [], baseline };
  const news: AlertNews[] = [];
  if (approvals.some((id) => !prev.approvals.has(id))) {
    const only = approvals.length === 1 ? approvals[0] : undefined;
    news.push({
      kind: 'approvals',
      count: approvals.length,
      ...(only === undefined ? {} : { approvalId: only }),
    });
  }
  for (const item of source.items) {
    if (item.read) continue;
    const before = prev.items.get(item.id);
    if (item.kind === 'messages' || item.kind === 'files') {
      if (item.ref === undefined) continue;
      const fresh =
        before === undefined || before.read || item.count > before.count || item.at > before.at;
      if (!fresh) continue;
      const grew = before !== undefined && !before.read && item.count >= before.count;
      const count = Math.max(1, grew ? item.count - before.count : item.count);
      news.push({ kind: item.kind, count, ref: item.ref });
    } else if (item.kind === 'update' && before === undefined) {
      news.push({ kind: 'update', count: 1 });
    }
  }
  return { news, baseline };
}

/** The switch that governs each kind. */
const SWITCH: Readonly<Record<NotifyKind, NotifyPrefKey>> = Object.freeze({
  approvals: 'approvals',
  messages: 'messages',
  files: 'files',
  update: 'updates',
});

/** The refs whose owner-given names are needed (Show names on only). */
export function refsToName(
  news: readonly AlertNews[],
  prefs: Readonly<Record<NotifyPrefKey, boolean>>,
): readonly string[] {
  if (!prefs.showNames) return [];
  const refs = new Set<string>();
  for (const n of news) if (n.ref !== undefined && prefs[SWITCH[n.kind]]) refs.add(n.ref);
  return [...refs];
}

/** The `notify` messages for this news under these switches and owner-given names. */
export function notifyMessages(
  news: readonly AlertNews[],
  prefs: Readonly<Record<NotifyPrefKey, boolean>>,
  names: ReadonlyMap<string, string>,
): NotifyMessage[] {
  const out: NotifyMessage[] = [];
  for (const n of news) {
    if (!prefs[SWITCH[n.kind]]) continue;
    let name = '';
    if (prefs.showNames && n.ref !== undefined && (n.kind === 'messages' || n.kind === 'files')) {
      const owner = names.get(n.ref);
      if (isNotifyName(owner)) name = owner;
    }
    const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(n.count)));
    // NOTIFY-DEEPLINK: only an opaque local ID of the shape the click may open (never content).
    const target = n.kind === 'approvals' ? n.approvalId : n.ref;
    out.push(
      Object.freeze({
        v: 1,
        type: 'notify',
        kind: n.kind,
        count,
        name,
        ...(isNotifyTarget(n.kind, target) ? { target } : {}),
      }),
    );
  }
  return out;
}
