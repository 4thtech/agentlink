// The page's reads (packages/node/src/local-ui/api/proofs.ts), checked before use: every value is a
// fixed word, a number or a dollar amount of a known shape. Anything else is left out (a row) or
// treated as "can't check right now" (credits), so nothing free-form from the server is shown.
import type { ProofState } from '@4thtech-io/ui';

export type Direction = 'sent' | 'received';

export interface ProofRow {
  readonly direction: Direction;
  readonly state: ProofState;
  /** Unix seconds. */
  readonly createdAt: number;
}

export type ListAnswer =
  | { readonly kind: 'ok'; readonly items: readonly ProofRow[]; readonly next?: string }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'error' };

export type CreditsAnswer =
  | {
      readonly kind: 'ok';
      readonly proofsLeft: number;
      readonly balance: string;
      readonly test: boolean;
      readonly partial: boolean;
    }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'unavailable' };

const STATES: ReadonlySet<string> = new Set([
  'recording',
  'submitted',
  'recorded',
  'needs-credits',
  'failed',
]);
const CURSOR = /^[\x21-\x7e]{1,220}$/;
const BALANCE = /^\$[0-9]{1,32}\.[0-9]{2}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function row(v: unknown): ProofRow | undefined {
  if (!isObject(v)) return undefined;
  const { direction, state, createdAt } = v;
  if (direction !== 'sent' && direction !== 'received') return undefined;
  if (typeof state !== 'string' || !STATES.has(state)) return undefined;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    return undefined;
  }
  return { direction, state: state as ProofState, createdAt };
}

export function parseList(data: unknown): ListAnswer {
  if (!isObject(data)) return { kind: 'error' };
  if (data.status === 'not_set_up') return { kind: 'not_set_up' };
  if (data.status !== 'ok' || !Array.isArray(data.items)) return { kind: 'error' };
  const items: ProofRow[] = [];
  for (const v of data.items as unknown[]) {
    const r = row(v);
    if (r !== undefined) items.push(r);
  }
  const next = data.nextCursor;
  return typeof next === 'string' && CURSOR.test(next)
    ? { kind: 'ok', items, next }
    : { kind: 'ok', items };
}

export function parseCredits(data: unknown): CreditsAnswer {
  if (!isObject(data)) return { kind: 'unavailable' };
  if (data.status === 'not_set_up') return { kind: 'not_set_up' };
  const { status, proofsLeft, balance, test, partial } = data;
  if (
    status !== 'ok' ||
    typeof proofsLeft !== 'number' ||
    !Number.isSafeInteger(proofsLeft) ||
    proofsLeft < 0 ||
    typeof balance !== 'string' ||
    !BALANCE.test(balance) ||
    typeof test !== 'boolean' ||
    typeof partial !== 'boolean'
  ) {
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', proofsLeft, balance, test, partial };
}

/** The list path: the first page, or the page after `cursor`. */
export function listPath(cursor?: string): string {
  const base = '/api/ui/proofs?limit=20';
  return cursor === undefined ? base : `${base}&cursor=${encodeURIComponent(cursor)}`;
}

export const CREDITS_PATH = '/api/ui/proofs/credits';
