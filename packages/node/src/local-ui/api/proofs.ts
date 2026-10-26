// M1-11c-a4: the Proofs and credits page's API (08 §1; 11 §5, §6.2; D-118; I-4, I-5, I-7).
//
// Two read routes, both `presence: false`, both through the read-only client view (context.ts):
// - `GET /api/ui/proofs?limit=&cursor=`: the stored proofs, newest first, paged by core.
// - `GET /api/ui/proofs/credits`: proofs left and the dollar balance over every proof network.
//
// Only what the default view shows leaves (UX north star; DESIGN-ADJ-1 PR-1, X-6): a proof row is
// its direction, one fixed display state and its time; credits are proofs left, a dollar balance,
// the price of one proof (core's PROOF_PRICE_USD_MICROS, the chain schedule) and two flags. Never
// a record, envelope or agent ID, a network, a token or an address (those stay in Advanced), and
// never an error's text (it could name a path or an RPC URL, 07 §6.1). A row core gives with a
// status or time this file does not know is left out, so nothing free-form reaches the page. The
// cursor is core's own opaque value, passed back unchanged.
//
// No mutating route: free test credits are claimed once by the agent itself (D-120 (3), M1-36i),
// and Add credits stays hidden until the pay page is live (X-6, D-113). Fixed answers:
// route-types.ts.
import {
  CoreError,
  PROOF_PRICE_USD_MICROS,
  type CreditsView,
  type ProofListItem,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
} from '../route-types.js';

/** The proof states the page draws (ui ProofBadge). */
export type ProofRowState = 'recording' | 'submitted' | 'recorded' | 'needs-credits' | 'failed';

const STATE: Readonly<Record<string, ProofRowState>> = Object.freeze({
  signed: 'recording',
  pending: 'submitted',
  needs_credits: 'needs-credits',
  failed: 'failed',
  conflict: 'failed',
  released: 'failed',
  recorded: 'recorded',
  announced: 'recorded',
  received: 'recorded',
});

const DEFAULT_LIMIT = 20;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const MAX_LIMIT = 100;
/** Printable ASCII, as core's cursor; core parses it strictly. */
const CURSOR = /^[\x21-\x7e]{1,220}$/;
const QUERY_KEYS: ReadonlySet<string> = new Set(['limit', 'cursor']);

/** limit and cursor, each at most once and well formed; nothing else. */
function parseQuery(query: URLSearchParams): { limit: number; cursor?: string } | undefined {
  for (const key of query.keys()) {
    if (!QUERY_KEYS.has(key)) return undefined;
  }
  const limits = query.getAll('limit');
  const cursors = query.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) return undefined;
  let limit = DEFAULT_LIMIT;
  const rawLimit = limits[0];
  if (rawLimit !== undefined) {
    if (!LIMIT.test(rawLimit)) return undefined;
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return undefined;
  }
  const cursor = cursors[0];
  if (cursor !== undefined && !CURSOR.test(cursor)) return undefined;
  return cursor === undefined ? { limit } : { limit, cursor };
}

function row(item: ProofListItem): JsonObject | undefined {
  const state = Object.hasOwn(STATE, item.status) ? STATE[item.status] : undefined;
  if (state === undefined) return undefined;
  if (item.direction !== 'sent' && item.direction !== 'received') return undefined;
  if (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0) return undefined;
  return { direction: item.direction, state, createdAt: item.createdAt };
}

async function listProofs(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  const query = parseQuery(request.query);
  if (query === undefined) return UI_INVALID_QUERY;
  try {
    const page = await client.proofs.list(query);
    const items: JsonObject[] = [];
    for (const item of page.items) {
      const r = row(item);
      if (r !== undefined) items.push(r);
    }
    const next = page.nextCursor;
    return {
      status: 200,
      body: {
        status: 'ok',
        items,
        ...(typeof next === 'string' && CURSOR.test(next) ? { nextCursor: next } : {}),
      },
    };
  } catch (error) {
    // Never the error's text: it could name a path.
    if (error instanceof CoreError && error.code === 'page_query_invalid') return UI_INVALID_QUERY;
    return UI_UNAVAILABLE;
  }
}

const USD = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]{1,18}))?$/;

/** A core USD amount in micro-dollars, rounded down; undefined when malformed. */
function usdMicros(value: string | null): bigint | undefined {
  if (value === null) return undefined;
  const m = USD.exec(value);
  if (m === null) return undefined;
  const frac = ((m[2] ?? '') + '000000').slice(0, 6);
  return BigInt(m[1] as string) * 1_000_000n + BigInt(frac);
}

/** `$4.80`: whole dollars and cents, rounded down. */
function dollars(micros: bigint): string {
  const cents = micros / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function creditsBody(view: CreditsView): JsonObject | undefined {
  if (view.status !== 'ok' || view.chains.length === 0) return undefined;
  let total = 0n;
  let partial = false;
  let read = 0;
  for (const chain of view.chains) {
    if (!chain.available) {
      partial = true;
      continue;
    }
    read += 1;
    for (const credit of chain.credits) {
      const micros = usdMicros(credit.usd);
      if (micros === undefined) partial = true;
      else total += micros;
    }
  }
  if (read === 0) return undefined;
  const left = total / PROOF_PRICE_USD_MICROS;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return {
    status: 'ok',
    proofsLeft: Number(left > max ? max : left),
    balance: dollars(total),
    price: dollars(PROOF_PRICE_USD_MICROS),
    test: view.chains.every((c) => c.testnet),
    partial,
  };
}

async function readCredits(context: LocalUiContext): Promise<LocalUiResult> {
  const client = context.client;
  if (client === undefined) return UI_NOT_SET_UP;
  try {
    const body = creditsBody(await client.proofs.creditsBalance());
    return body === undefined ? UI_UNAVAILABLE : { status: 200, body };
  } catch {
    // Never the error's text: it could name an RPC URL (07 §6.1).
    return UI_UNAVAILABLE;
  }
}

export const proofsRoutes: readonly LocalUiReadRoute[] = Object.freeze([
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: '/api/ui/proofs',
    presence: false,
    handler: listProofs,
  }),
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: '/api/ui/proofs/credits',
    presence: false,
    handler: (context) => readCredits(context),
  }),
]);
