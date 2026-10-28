// Home's reads, checked before use (UI-REFRESH-g; I-5). Home reads only routes that exist
// (plan §6) and keeps from each answer only what its tile shows: a fixed word, a number, a time, or
// one short line of text (an approval's summary), clamped. Anything else in a body is dropped here,
// so nothing else can reach the page.
import type { ApiResult } from '../../api/client.js';
import { parseHealth, type HealthState } from '../../layout/health.js';
import type { ApprovalItem } from '../approvals/client.js';
import { parseCredits } from '../proofs/data.js';

export const ACTIVITY_PATH = '/api/ui/activity?limit=3';
export const SUMMARY_MAX = 80;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSeconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export interface HealthSnapshot {
  readonly agent: HealthState;
  readonly relays: { readonly connected: number; readonly total: number } | null;
  /** Unix seconds of the last completed sync. */
  readonly lastSyncAt: number | null;
  readonly version: string | null;
}

/** The health answer as Home uses it, or undefined when it is not a well-formed answer. */
export function parseHealthSnapshot(result: ApiResult<unknown>): HealthSnapshot | undefined {
  const answer = parseHealth(result);
  if (answer === undefined || result.kind !== 'ok' || !isRecord(result.data)) return undefined;
  const { relays, lastSyncAt } = result.data;
  let routes: HealthSnapshot['relays'] = null;
  if (isRecord(relays)) {
    const { connected, total } = relays;
    if (
      typeof connected === 'number' &&
      typeof total === 'number' &&
      Number.isInteger(connected) &&
      Number.isInteger(total) &&
      connected >= 0 &&
      total >= connected &&
      total <= 32
    ) {
      routes = { connected, total };
    }
  }
  return {
    agent: answer.state,
    relays: routes,
    lastSyncAt: isSeconds(lastSyncAt) ? lastSyncAt : null,
    version: answer.version ?? null,
  };
}

export type EventKind =
  | 'approved'
  | 'approvedByRules'
  | 'denied'
  | 'cancelled'
  | 'proofSent'
  | 'proofReceived'
  | 'senderBlocked'
  | 'contactBlocked'
  | 'rulesChanged';

/** One Last activity row: a kind (a fixed label) and a time. Never a name, text or file name. */
export interface EventRow {
  readonly kind: EventKind;
  readonly at: number;
}

const DECISION: Readonly<Record<string, EventKind>> = {
  approved: 'approved',
  approved_by_rules: 'approvedByRules',
  denied: 'denied',
  cancelled: 'cancelled',
};
const PROOF_STATES: ReadonlySet<string> = new Set([
  'submitted',
  'needs_credits',
  'failed',
  'recorded',
  'received',
]);

/** The newest three known events; an entry of another kind (a message, say) is left out. */
export function parseEvents(data: unknown): readonly EventRow[] | undefined {
  if (!isRecord(data) || !Array.isArray(data['items'])) return undefined;
  const out: EventRow[] = [];
  for (const raw of data['items'] as unknown[]) {
    if (!isRecord(raw) || !isSeconds(raw['at'])) continue;
    const at = raw['at'];
    let kind: EventKind | undefined;
    switch (raw['kind']) {
      case 'approval_decided':
        kind =
          typeof raw['decision'] === 'string' && Object.hasOwn(DECISION, raw['decision'])
            ? DECISION[raw['decision']]
            : undefined;
        break;
      case 'proof':
        if (
          (raw['direction'] === 'sent' || raw['direction'] === 'received') &&
          typeof raw['state'] === 'string' &&
          PROOF_STATES.has(raw['state'])
        ) {
          kind =
            raw['state'] === 'received' || raw['direction'] === 'received'
              ? 'proofReceived'
              : 'proofSent';
        }
        break;
      case 'sender_blocked':
        kind = 'senderBlocked';
        break;
      case 'contact_blocked':
        kind = 'contactBlocked';
        break;
      case 'rules_changed':
        kind = 'rulesChanged';
        break;
      default:
        kind = undefined;
    }
    if (kind !== undefined) out.push({ kind, at });
    if (out.length === 3) break;
  }
  return out;
}

export interface CreditsView {
  readonly proofsLeft: number;
  readonly balance: string;
}

export function creditsOf(data: unknown): CreditsView | 'unavailable' {
  const answer = parseCredits(data);
  return answer.kind === 'ok'
    ? { proofsLeft: answer.proofsLeft, balance: answer.balance }
    : 'unavailable';
}

export interface WaitingView {
  readonly count: number;
  /** The soonest item: its summary (plain text, clamped) and when it expires (unix seconds). */
  readonly soonest: { readonly summary: string; readonly expiresAt: number } | null;
}

/** Clamp inbound text to one short line; it is rendered as React text only. */
export function clampLine(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function waitingOf(items: readonly ApprovalItem[]): WaitingView {
  const soonest = [...items].sort((a, b) => a.expiresAt - b.expiresAt)[0];
  return {
    count: items.length,
    soonest:
      soonest === undefined
        ? null
        : { summary: clampLine(soonest.summary), expiresAt: soonest.expiresAt },
  };
}
