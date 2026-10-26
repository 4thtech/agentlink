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
// No free test credits route: they are claimed once by the agent itself (D-120 (3), M1-36i).
//
// M1-11c-a4c (D-122, D-123; 12 §4.1, §4.4; 11 §5.6; 04 §2.5): Add credits by QR and Withdraw credits.
// - `GET /api/ui/proofs/top-up` (no presence): per network one fixed word. On the Gnosis test
//   network (Chiado, the one top-up network for now) also the agent's address, for the QR code and
//   the copy button the owner opens (the only route that returns it: funds are sent there), what
//   arrived, what can become credits and the credits that can be withdrawn, in dollars and base
//   units. Base Sepolia is "coming soon"; a mainnet or unknown chain is left out.
// - `POST /api/ui/proofs/top-up` and `POST /api/ui/proofs/withdraw` are owner operations
//   (`presence: true`: the central presence gate runs first). Each checks its input against a fresh
//   read (the network, the exact amount the page showed and the owner confirmed), signs exactly one
//   `credits.deposit` or `credits.withdraw` with the owner key, and hands it to core, which verifies
//   it again and sends the agent's own `deposit` or `withdraw`. A withdrawal always goes to the
//   agent's own account (the recipient grant is a later card, IR-M1-4c-b-1 M-1). Bad input signs
//   nothing, and the gate answers 409 `refused`.
// Fixed answers: route-types.ts and below. Never an error's text, a key or a transaction hash.
import {
  CoreError,
  PROOF_PRICE_USD_MICROS,
  type CreditsView,
  type ProofListItem,
} from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  randomBytes,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import type { CreditsMoveResult, TopUpChain, TopUpView } from '@4thtech-io/core';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
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

// ---- Add credits and Withdraw credits (M1-11c-a4c) ----------------------------------------------

/** The networks the page names, by chain ID: a fixed word, and its plain name for the review. */
const NETWORKS: Readonly<Record<number, { readonly word: string; readonly name: string }>> =
  Object.freeze({
    10200: Object.freeze({ word: 'gnosis-test', name: 'Gnosis test network' }),
    84532: Object.freeze({ word: 'base-test', name: 'Base test network' }),
  });
/** The one network where funds sent to the agent's address become credits (D-123). */
const ADDRESS_NETWORK = 10200;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const UNITS = /^(0|[1-9][0-9]{0,77})$/;
/** A credits move's lifetime: confirmed on the page and sent at once (L(op) = 600 s). */
const MOVE_LIFETIME_S = 600;

type Ready = Extract<TopUpChain, { available: true }>;

const networkOf = (chainId: number) =>
  Object.hasOwn(NETWORKS, chainId) ? NETWORKS[chainId] : undefined;

/** `{usd: '$4.99', amount}` from a core amount, or undefined when malformed. */
function moneyOf(value: unknown): { usd: string; amount: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { amount, usd } = value as { amount?: unknown; usd?: unknown };
  if (typeof amount !== 'string' || !UNITS.test(amount) || typeof usd !== 'string') {
    return undefined;
  }
  const micros = usdMicros(usd);
  return micros === undefined ? undefined : { usd: dollars(micros), amount };
}

/** One network as the page gets it, or undefined (left out). */
function networkEntry(chain: TopUpChain, address: string): JsonObject | undefined {
  const network = networkOf(chain.chainId);
  if (network === undefined) return undefined;
  if (chain.method === 'coming_soon') return { network: network.word, method: 'coming_soon' };
  if (chain.method !== 'address' || chain.chainId !== ADDRESS_NETWORK) return undefined;
  if (!EVM_ADDRESS.test(address)) return undefined;
  if (chain.available !== true) {
    return { network: network.word, method: 'address', available: false, address };
  }
  const received = moneyOf(chain.received);
  const addable = moneyOf(chain.addable);
  const credits = moneyOf(chain.credits);
  if (received === undefined || addable === undefined || credits === undefined) return undefined;
  return {
    network: network.word,
    method: 'address',
    available: true,
    address,
    received: received.usd,
    addable,
    credits,
  };
}

async function readTopUpView(
  context: LocalUiContext,
): Promise<{ view: Extract<TopUpView, { status: 'ok' }> } | { result: LocalUiResult }> {
  const client = context.client;
  if (client === undefined) return { result: UI_NOT_SET_UP };
  try {
    const view = await client.proofs.topUp();
    return view.status === 'ok' ? { view } : { result: UI_UNAVAILABLE };
  } catch {
    // Never the error's text: it could name an RPC URL (07 §6.1).
    return { result: UI_UNAVAILABLE };
  }
}

async function topUpRead(context: LocalUiContext): Promise<LocalUiResult> {
  const read = await readTopUpView(context);
  if ('result' in read) return read.result;
  const networks: JsonObject[] = [];
  for (const chain of read.view.chains) {
    const entry = networkEntry(chain, read.view.agentId);
    if (entry !== undefined) networks.push(entry);
  }
  return { status: 200, body: { status: 'ok', networks } };
}

/** A move's input: exactly `{network, amount}` on the address network, else undefined. */
function moveInput(input: JsonValue | undefined): { amount: string } | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'amount' || keys[1] !== 'network') return undefined;
  const { network, amount } = input as { network: unknown; amount: unknown };
  if (network !== networkOf(ADDRESS_NETWORK)?.word) return undefined;
  if (typeof amount !== 'string' || !UNITS.test(amount) || amount === '0') return undefined;
  return { amount };
}

const MOVE_REFUSED: LocalUiResult = Object.freeze({
  status: 409,
  body: Object.freeze({ error: 'refused' }),
});

/** Core's outcome as a fixed answer. */
function moveAnswer(result: CreditsMoveResult): LocalUiResult {
  switch (result.status) {
    case 'done':
      return { status: 200, body: { status: 'done' } };
    case 'pending':
      return { status: 202, body: { status: 'pending' } };
    case 'refused':
      return result.reason === 'amount_unavailable'
        ? { status: 409, body: { error: 'amount_changed' } }
        : MOVE_REFUSED;
    case 'failed':
      if (result.reason === 'no_funds_for_fee') {
        return { status: 502, body: { error: 'no_funds_for_fee' } };
      }
      return result.reason === 'reverted'
        ? { status: 502, body: { error: 'failed' } }
        : UI_UNAVAILABLE;
    default:
      return MOVE_REFUSED;
  }
}

/**
 * One credits move: the input against a fresh read, then one owner signature over exactly the
 * `credits.deposit` or `credits.withdraw` the page confirmed, then core. Returning before `sign`
 * performs no owner operation (the gate answers 409).
 */
async function moveCredits(
  kind: 'deposit' | 'withdraw',
  context: LocalUiContext,
  request: LocalUiRequest,
  owner: LocalUiOwnerOperation,
): Promise<LocalUiResult> {
  const input = moveInput(request.input);
  if (input === undefined) return MOVE_REFUSED;
  const port = context.credits;
  if (context.client === undefined || port === undefined) return UI_NOT_SET_UP;
  const who = await context.ownerContext();
  if (who === undefined || who.agent !== context.client.agentId) return UI_NOT_SET_UP;
  const read = await readTopUpView(context);
  if ('result' in read) return read.result;
  if (read.view.agentId !== who.agent) return MOVE_REFUSED;
  const chain = read.view.chains.find(
    (c): c is Ready =>
      c.chainId === ADDRESS_NETWORK && c.method === 'address' && c.available === true,
  );
  if (chain === undefined) return MOVE_REFUSED;
  const shown = moneyOf(kind === 'deposit' ? chain.addable : chain.credits);
  // Exactly the amount the page showed and the owner confirmed; anything else is a new review.
  if (shown === undefined || shown.amount !== input.amount) return MOVE_REFUSED;
  const network = (networkOf(ADDRESS_NETWORK) as { name: string }).name;
  const issuedAt = Math.floor(context.now() / 1000);
  const params: JsonObject =
    kind === 'deposit'
      ? { chainId: ADDRESS_NETWORK, token: 'NATIVE', amount: input.amount }
      : { chainId: ADDRESS_NETWORK, token: 'NATIVE', amount: input.amount, to: who.agent };
  const action: JsonObject = {
    v: 1,
    agent: who.agent,
    owner: encodeHex(who.owner.ownerNostr),
    op: kind === 'deposit' ? 'credits.deposit' : 'credits.withdraw',
    params,
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + MOVE_LIFETIME_S,
  };
  const lines =
    kind === 'deposit'
      ? [`Add ${shown.usd} to your credits from funds your agent received on the ${network}.`]
      : [`Withdraw ${shown.usd} of credits to your agent's own account on the ${network}.`];
  const [signature] = await owner.sign({ lines }, [{ kind: 'owner-action', action }]);
  if (signature?.kind !== 'owner-action') return MOVE_REFUSED;
  const result =
    kind === 'deposit'
      ? await port.addReceivedFunds(signature.signed)
      : await port.withdrawCredits(signature.signed);
  return moveAnswer(result);
}

export const proofsRoutes: readonly LocalUiRoute[] = Object.freeze([
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
  Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: '/api/ui/proofs/top-up',
    presence: false,
    handler: (context) => topUpRead(context),
  }),
  Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path: '/api/ui/proofs/top-up',
    presence: true,
    handler: (context, request, owner) => moveCredits('deposit', context, request, owner),
  }),
  Object.freeze<LocalUiOwnerRoute>({
    method: 'POST',
    path: '/api/ui/proofs/withdraw',
    presence: true,
    handler: (context, request, owner) => moveCredits('withdraw', context, request, owner),
  }),
]);
