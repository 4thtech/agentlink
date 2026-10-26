// The page's reads (packages/node/src/local-ui/api/proofs.ts; the shared answers 409 not_set_up and
// 503 unavailable are in its route-types.ts), checked before use: every value is a
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
      /** One proof, `$N.NN` (core's price, from the chain schedule). */
      readonly price: string;
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
  const { status, proofsLeft, balance, price, test, partial } = data;
  if (
    status !== 'ok' ||
    typeof proofsLeft !== 'number' ||
    !Number.isSafeInteger(proofsLeft) ||
    proofsLeft < 0 ||
    typeof balance !== 'string' ||
    !BALANCE.test(balance) ||
    typeof price !== 'string' ||
    !BALANCE.test(price) ||
    typeof test !== 'boolean' ||
    typeof partial !== 'boolean'
  ) {
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', proofsLeft, balance, price, test, partial };
}

/** The list path: the first page, or the page after `cursor`. */
export function listPath(cursor?: string): string {
  const base = '/api/ui/proofs?limit=20';
  return cursor === undefined ? base : `${base}&cursor=${encodeURIComponent(cursor)}`;
}

export const CREDITS_PATH = '/api/ui/proofs/credits';

// ---- Add credits and Withdraw credits (M1-11c-a4c) ------------------------------------------------

export const TOP_UP_PATH = '/api/ui/proofs/top-up';
export const WITHDRAW_PATH = '/api/ui/proofs/withdraw';

export type NetworkWord = 'gnosis-test' | 'base-test';

export interface Money {
  /** `$N.NN`. */
  readonly usd: string;
  /** Base units, a decimal string: sent back unchanged as the confirmed amount. */
  readonly amount: string;
}

export type TopUpNetwork =
  | { readonly network: NetworkWord; readonly method: 'coming_soon' }
  | {
      readonly network: 'gnosis-test';
      readonly method: 'address';
      readonly available: false;
      readonly address: string;
    }
  | {
      readonly network: 'gnosis-test';
      readonly method: 'address';
      readonly available: true;
      readonly address: string;
      readonly received: string;
      readonly addable: Money;
      readonly credits: Money;
    };

export type TopUpAnswer =
  | { readonly kind: 'ok'; readonly networks: readonly TopUpNetwork[] }
  | { readonly kind: 'unavailable' };

const NETWORK_WORDS: ReadonlySet<string> = new Set(['gnosis-test', 'base-test']);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UNITS = /^(0|[1-9][0-9]{0,77})$/;

function money(v: unknown): Money | undefined {
  if (!isObject(v)) return undefined;
  const { usd, amount } = v;
  if (typeof usd !== 'string' || !BALANCE.test(usd)) return undefined;
  if (typeof amount !== 'string' || !UNITS.test(amount)) return undefined;
  return { usd, amount };
}

function network(v: unknown): TopUpNetwork | undefined {
  if (!isObject(v)) return undefined;
  const { network: word, method } = v;
  if (typeof word !== 'string' || !NETWORK_WORDS.has(word)) return undefined;
  if (method === 'coming_soon') return { network: word as NetworkWord, method };
  // Only the Gnosis test network takes funds at the agent's address (D-123).
  if (method !== 'address' || word !== 'gnosis-test') return undefined;
  const { address, available } = v;
  if (typeof address !== 'string' || !ADDRESS.test(address)) return undefined;
  if (available === false) return { network: word, method, available, address };
  if (available !== true) return undefined;
  const received = v.received;
  const addable = money(v.addable);
  const credits = money(v.credits);
  if (typeof received !== 'string' || !BALANCE.test(received)) return undefined;
  if (addable === undefined || credits === undefined) return undefined;
  return { network: word, method, available, address, received, addable, credits };
}

export function parseTopUp(data: unknown): TopUpAnswer {
  if (!isObject(data) || data.status !== 'ok' || !Array.isArray(data.networks)) {
    return { kind: 'unavailable' };
  }
  const networks: TopUpNetwork[] = [];
  for (const v of data.networks as unknown[]) {
    const n = network(v);
    if (n !== undefined) networks.push(n);
  }
  return { kind: 'ok', networks };
}

/** The one network where funds sent to the agent's address become credits, if offered. */
export function addressNetwork(
  answer: TopUpAnswer,
): Extract<TopUpNetwork, { method: 'address' }> | undefined {
  if (answer.kind !== 'ok') return undefined;
  return answer.networks.find(
    (n): n is Extract<TopUpNetwork, { method: 'address' }> => n.method === 'address',
  );
}

/** `true` for a base-units amount above zero. */
export const isPositive = (amount: string): boolean => amount !== '0';
