// The gasless top-up step, core side (12 §4.1 "gasless USDC"; 07 §7; 05 §2.5; 04 §2.5; D-123;
// M3-4b-t-T4-a). The agent turns test USDC already at its own address into its own credits: the
// AGENT KeyStore signs an EIP-3009 `ReceiveWithAuthorization` (vault payee) through the chain
// package's builder, a shipped submitter redeems it and pays the network cost, and the core
// confirms the credit by reading `creditsOf` on chain.
//
// Internal on purpose: NOT exported from the core index, and no MCP tool or agent request reaches it
// (owner decision 2026-10-23: only owner-started top-ups). The one caller is the owner-signed
// `credits.deposit` path (T4-c, credits-move.ts), which hands over the owner-signed object as it
// arrived. The step itself:
// 1. requires that object (`approval_required` without it) and has the owner-action verifier
//    (`GaslessApprovalPort`, T4-c wires OwnerActions' 04 §2.5.1 object checks) vouch for exactly it:
//    the verifier's action hash must equal sha256(JCS(object)) recomputed here. The chain, token and
//    amount come only from that object, never from a separate argument;
// 2. honours the client-side kill switch: `kit.gaslessToken` refuses every token while the shipped
//    registry has GASLESS_TOPUP_ENABLED false (`gasless_unavailable`), before any chain read;
// 3. Base Sepolia USDC only, $5 to $50 (owner decision 2026-10-23), checked before signing;
// 4. one top-up at a time per agent in this process, and never above the agent's USDC balance less
//    what its unconfirmed authorizations still may move;
// 5. records the approval's nonce in `owner_action_nonces` before signing, in the same store
//    transaction that counts the agent's approved top-ups of the last hour (at most 5, every
//    approved attempt counts, owner decision 2026-10-23). One approval gives at most one
//    authorization, also across a restart;
// 6. signs with the agent KeyStore only: it takes no owner signer, and the authorization must name
//    the agent's own ID as `from` (the builder checks the signature recovers to it);
// 7. checks the built authorization again (payee, value, window of at most 15 minutes) before the
//    port sees it;
// 8. treats the submitter's answer as untrusted: `done` only once `creditsOf` rose by the amount.
// Results and log lines are fixed words: never a transaction hash, signature, nonce, address, amount
// or URL (I-7).
import { CLOCK_SKEW_SECONDS } from '@4thtech-io/types';
import type { DepositAuthorizationRequest, GaslessToken, Hex } from '@4thtech-io/chain';
import { nowOf, type CoreContext } from '../context.js';
import { ownerActionHash } from '../owner-action.js';
import type { DepositAuthAnswer, ProofChain, ProofsPlatform } from './platform.js';

export type { DepositAuthAnswer, DepositAuthPort } from './platform.js';

/** The chains with a gasless top-up (Base Sepolia; the chain package's GASLESS_CHAIN_IDS). */
const GASLESS_TOPUP_CHAIN_IDS: readonly number[] = Object.freeze([84532]);
/** The only token of the gasless top-up (12 §4.1). */
const GASLESS_TOPUP_TOKEN = 'USDC';
/** Seconds the signed authorization stays valid: 15 minutes (owner decision 2026-10-23). */
export const GASLESS_TOPUP_WINDOW_SECONDS = 900;
/** Approved gasless top-ups per agent per hour, every approved attempt counted (owner decision). */
export const GASLESS_TOPUP_LIMIT_PER_HOUR = 5;
const RATE_WINDOW_SECONDS = 3_600;
/** The longest `credits.deposit` approval accepted (04 §2.5.1 lifetime 600 s). */
const APPROVAL_MAX_LIFETIME_SECONDS = 600;
const OP = 'credits.deposit';
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const DEFAULT_POLL = Object.freeze({ attempts: 12, intervalMs: 5_000 });

/** What the owner-action verifier says about the owner-signed object it was given. */
export type GaslessApprovalVerdict =
  | {
      readonly ok: true;
      /** sha256(JCS(SignedOwnerAction)), 64 lowercase hex (07 §3.4 `action_hash`). */
      readonly actionHash: string;
    }
  | { readonly ok: false };

/**
 * The owner-action verifier (T4-c: OwnerActions' `credits.deposit` object checks, 04 §2.5.1:
 * encoding and strict schema, agent, owner, signature, freshness, lifetime, nonce unused). It
 * writes nothing: this step records the nonce.
 */
export interface GaslessApprovalPort {
  verify(input: unknown): Promise<GaslessApprovalVerdict>;
}

export interface GaslessTopUpDeps {
  /** `ctx.keyStore` is the AGENT KeyStore: the only signer this step ever uses. */
  readonly ctx: CoreContext;
  readonly platform: ProofsPlatform | undefined;
  readonly approvals: GaslessApprovalPort;
  /** The agent's ID (its EVM address), or undefined before init. */
  readonly agentId: () => Promise<string | undefined>;
  /** The chain selector's cache, cleared once credits may have changed (07 §6.3). */
  readonly selector?: { clear(): void };
  /** How the credit is awaited on chain. Default 12 reads, 5 s apart. */
  readonly poll?: {
    readonly attempts: number;
    readonly intervalMs: number;
    readonly sleep?: (ms: number) => Promise<void>;
  };
}

export interface GaslessTopUpInput {
  /** The owner-signed `credits.deposit` object, exactly as it arrived. Required. */
  readonly approval: unknown;
}

export type GaslessTopUpRefusal =
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_used'
  | 'not_available'
  | 'gasless_unavailable'
  | 'unsupported_chain'
  | 'unsupported_token'
  | 'below_minimum'
  | 'above_maximum'
  | 'amount_unavailable'
  | 'busy';

export type GaslessTopUpFailure =
  | 'rate_limited'
  | 'already_used'
  | 'unavailable'
  | 'refused'
  | 'signer_mismatch'
  | 'invalid_authorization';

/** Fixed words only (I-7). */
export type GaslessTopUpResult =
  /** The credits are on chain. */
  | { readonly status: 'done' }
  /** Sent; the credits did not show yet. The authorization expires within 15 minutes. */
  | { readonly status: 'pending' }
  /** Nothing was signed, or the signed authorization was never sent. */
  | { readonly status: 'refused'; readonly reason: GaslessTopUpRefusal }
  /** The local limit: seconds until another approved top-up may run. */
  | { readonly status: 'refused'; readonly reason: 'rate_limited'; readonly retryAfter: number }
  /** Signed, but not credited: the submitter refused it, or it never reached one. */
  | { readonly status: 'failed'; readonly reason: GaslessTopUpFailure };

const refused = (reason: GaslessTopUpRefusal): GaslessTopUpResult =>
  Object.freeze({ status: 'refused', reason });
const failed = (reason: GaslessTopUpFailure): GaslessTopUpResult =>
  Object.freeze({ status: 'failed', reason });

/** Per platform (one runtime): the agent in progress and its unconfirmed authorizations. */
interface Flight {
  readonly busy: Set<string>;
  readonly reserved: Map<string, { readonly amount: bigint; readonly validBefore: number }[]>;
}
const flights = new WeakMap<ProofsPlatform, Flight>();

function flightOf(platform: ProofsPlatform): Flight {
  let flight = flights.get(platform);
  if (flight === undefined) {
    flight = { busy: new Set(), reserved: new Map() };
    flights.set(platform, flight);
  }
  return flight;
}

/** A chain error's fixed code, by name (the core imports only types from the chain package). */
function chainCode(error: unknown): { readonly input: boolean; readonly code: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (typeof code !== 'string') return undefined;
  if (name === 'ChainInputError') return { input: true, code };
  if (name === 'ChainError') return { input: false, code };
  return undefined;
}

/** The refusal word for a builder or gate ChainInputError code. */
function inputRefusal(code: string): GaslessTopUpRefusal {
  switch (code) {
    case 'gasless_unavailable':
    case 'unsupported_chain':
      return code;
    case 'below_min_deposit':
      return 'below_minimum';
    case 'above_max_top_up':
      return 'above_maximum';
    case 'insufficient_balance':
      return 'amount_unavailable';
    default:
      return 'not_available';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ApprovedParams {
  readonly agent: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly chainId: number;
  readonly token: string;
  readonly amount: bigint;
}

/** Reads the fields this step needs; the verifier checks the whole object strictly. */
function readApproval(input: unknown): ApprovedParams | undefined {
  if (!isObject(input) || !isObject(input.body)) return undefined;
  const { op, agent, nonce, issuedAt, expiresAt, params } = input.body;
  if (
    op !== OP ||
    typeof agent !== 'string' ||
    typeof nonce !== 'string' ||
    nonce.length === 0 ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !isObject(params)
  ) {
    return undefined;
  }
  const { chainId, token, amount } = params;
  if (
    !Number.isSafeInteger(chainId) ||
    typeof token !== 'string' ||
    typeof amount !== 'string' ||
    !AMOUNT.test(amount)
  ) {
    return undefined;
  }
  return {
    agent,
    nonce,
    issuedAt: issuedAt as number,
    expiresAt: expiresAt as number,
    chainId: chainId as number,
    token,
    amount: BigInt(amount),
  };
}

function hashOf(input: unknown): string | undefined {
  try {
    return ownerActionHash(input);
  } catch {
    return undefined;
  }
}

/** The authorization the builder returned, checked again before anything is sent. */
function checkBuilt(
  request: DepositAuthorizationRequest,
  expected: {
    readonly chainId: number;
    readonly deployment: GaslessToken;
    readonly agentId: string;
    readonly amount: bigint;
    readonly now: number;
  },
): GaslessTopUpFailure | undefined {
  const auth = isObject(request) && isObject(request.auth) ? request.auth : undefined;
  if (auth === undefined) return 'invalid_authorization';
  if (String(auth.from) !== expected.agentId.toLowerCase()) return 'signer_mismatch';
  const validBefore = Number(auth.validBefore);
  if (
    request.chainId !== expected.chainId ||
    request.token !== expected.deployment.token ||
    auth.to !== expected.deployment.vault ||
    auth.value !== expected.amount.toString() ||
    auth.validAfter !== '0' ||
    typeof auth.validBefore !== 'string' ||
    !Number.isSafeInteger(validBefore) ||
    validBefore <= expected.now ||
    validBefore - expected.now > GASLESS_TOPUP_WINDOW_SECONDS
  ) {
    return 'invalid_authorization';
  }
  return undefined;
}

function finish(deps: GaslessTopUpDeps, result: GaslessTopUpResult): GaslessTopUpResult {
  if (result.status !== 'done') {
    // Fixed words only: never the error's text, an address, an amount or a URL (I-7).
    deps.ctx.log.warn('gasless top-up not completed', {
      outcome: 'reason' in result ? result.reason : result.status,
    });
  }
  return result;
}

/**
 * Runs one owner-approved gasless top-up (see the module comment for every rule). Never throws for
 * a refusal or a chain or submitter failure: the result is a fixed word.
 */
export async function runGaslessTopUp(
  deps: GaslessTopUpDeps,
  input: GaslessTopUpInput,
): Promise<GaslessTopUpResult> {
  return finish(deps, await run(deps, input));
}

async function run(deps: GaslessTopUpDeps, input: GaslessTopUpInput): Promise<GaslessTopUpResult> {
  const approval: unknown = isObject(input) ? input.approval : undefined;
  if (!isObject(approval) || !isObject(approval.body)) return refused('approval_required');
  const platform = deps.platform;
  const port = platform?.depositAuth;
  const agentId = await deps.agentId();
  if (platform === undefined || port === undefined || agentId === undefined) {
    return refused('not_available');
  }
  const params = readApproval(approval);
  if (params === undefined) return refused('approval_invalid');

  // The chain and the token, then the kill switch: no chain read and no signature before these.
  const chain: ProofChain | undefined = platform.chains.find(
    (c) => c.config.chainId === params.chainId,
  );
  if (chain?.config.testnet !== true || !GASLESS_TOPUP_CHAIN_IDS.includes(params.chainId)) {
    return refused('unsupported_chain');
  }
  if (params.token !== GASLESS_TOPUP_TOKEN) return refused('unsupported_token');
  let deployment: GaslessToken;
  let bounds: { readonly min: bigint; readonly max: bigint };
  try {
    deployment = platform.kit.gaslessToken(chain.config, GASLESS_TOPUP_TOKEN);
    bounds = platform.kit.gaslessValueBounds(deployment.decimals);
  } catch (error) {
    const known = chainCode(error);
    return refused(known?.input === true ? inputRefusal(known.code) : 'not_available');
  }
  if (params.amount < bounds.min) return refused('below_minimum');
  if (params.amount > bounds.max) return refused('above_maximum');

  // The owner approval: the verifier vouches for exactly this object, for this agent, still fresh.
  let verdict: GaslessApprovalVerdict;
  try {
    verdict = await deps.approvals.verify(approval);
  } catch {
    return refused('approval_invalid');
  }
  const now = nowOf(deps.ctx);
  const actionHash = hashOf(approval);
  if (
    verdict.ok !== true ||
    actionHash === undefined ||
    verdict.actionHash !== actionHash ||
    params.agent !== agentId ||
    params.expiresAt <= now ||
    params.expiresAt <= params.issuedAt ||
    params.expiresAt - params.issuedAt > APPROVAL_MAX_LIFETIME_SECONDS ||
    params.issuedAt > now + CLOCK_SKEW_SECONDS
  ) {
    return refused('approval_invalid');
  }

  const flight = flightOf(platform);
  if (flight.busy.has(agentId)) return refused('busy');
  flight.busy.add(agentId);
  try {
    return await signAndSend(deps, {
      platform,
      port,
      chain,
      deployment,
      flight,
      agentId,
      params,
      actionHash,
      now,
    });
  } finally {
    flight.busy.delete(agentId);
  }
}

async function signAndSend(
  deps: GaslessTopUpDeps,
  s: {
    readonly platform: ProofsPlatform;
    readonly port: NonNullable<ProofsPlatform['depositAuth']>;
    readonly chain: ProofChain;
    readonly deployment: GaslessToken;
    readonly flight: Flight;
    readonly agentId: string;
    readonly params: ApprovedParams;
    readonly actionHash: string;
    readonly now: number;
  },
): Promise<GaslessTopUpResult> {
  const { platform, port, chain, deployment, flight, agentId, params, now } = s;
  const amount = params.amount;
  const agent = agentId.toLowerCase() as Hex;

  // The balance less what unconfirmed authorizations may still move, and the credits before.
  const reserved = (flight.reserved.get(agentId) ?? []).filter((r) => r.validBefore > now);
  flight.reserved.set(agentId, reserved);
  let creditsBefore: bigint;
  try {
    const balance = await chain.state.tokenBalance(deployment.token, agent);
    const held = reserved.reduce((sum, r) => sum + r.amount, 0n);
    if (typeof balance !== 'bigint' || amount > balance - held) {
      return refused('amount_unavailable');
    }
    creditsBefore = await chain.state.creditsOf(agent, deployment.token);
    if (typeof creditsBefore !== 'bigint') return failed('unavailable');
  } catch {
    return failed('unavailable');
  }

  // The approval applies once; the agent's approved top-ups of the last hour are at most 5.
  const claim = await deps.ctx.store.transaction((tx) => {
    if (tx.get('owner_action_nonces', { nonce: params.nonce }) !== undefined) {
      return { used: true } as const;
    }
    const recent = tx.select(
      'owner_action_nonces',
      { op: OP, applied_at: { gt: now - RATE_WINDOW_SECONDS } },
      { orderBy: [['applied_at', 'asc']] },
    );
    if (recent.length >= GASLESS_TOPUP_LIMIT_PER_HOUR) {
      const freesAt =
        (recent[recent.length - GASLESS_TOPUP_LIMIT_PER_HOUR]?.applied_at ?? now) +
        RATE_WINDOW_SECONDS;
      return { retryAfter: Math.max(1, freesAt - now) } as const;
    }
    tx.insert('owner_action_nonces', {
      nonce: params.nonce,
      op: OP,
      action_hash: s.actionHash,
      issued_at: params.issuedAt,
      expires_at: params.expiresAt,
      applied_at: now,
    });
    return { claimed: true } as const;
  });
  if ('used' in claim) return refused('approval_used');
  if ('retryAfter' in claim) {
    return Object.freeze({
      status: 'refused',
      reason: 'rate_limited',
      retryAfter: claim.retryAfter,
    });
  }

  // The agent KeyStore signs; only its address and its EIP-712 signer are handed over.
  const keyStore = deps.ctx.keyStore;
  let request: DepositAuthorizationRequest;
  try {
    request = await platform.kit.buildReceiveWithAuthorization(
      chain.state,
      {
        getPublicBundle: (options) => keyStore.getPublicBundle(options),
        sign712: (typedData) => keyStore.sign712(typedData),
      },
      { token: GASLESS_TOPUP_TOKEN, value: amount },
      {
        ethCall: platform.kit.readClientEthCall(chain.client),
        nowSeconds: () => now,
        windowSeconds: GASLESS_TOPUP_WINDOW_SECONDS,
      },
    );
  } catch (error) {
    const known = chainCode(error);
    if (known?.input === true) return refused(inputRefusal(known.code));
    return failed(known?.code === 'signer_mismatch' ? 'signer_mismatch' : 'unavailable');
  }
  const bad = checkBuilt(request, { chainId: params.chainId, deployment, agentId, amount, now });
  if (bad !== undefined) return failed(bad);

  let answer: DepositAuthAnswer;
  try {
    answer = await port.submit(request);
  } catch {
    return failed('unavailable');
  } finally {
    // Credits may change: never pay from the cached detection (07 §6.3).
    deps.selector?.clear();
  }
  switch (answer.status) {
    case 'submitted':
      break;
    case 'rate_limited':
    case 'already_used':
    case 'unavailable':
      return failed(answer.status);
    case 'refused':
      return failed('refused');
    default:
      return failed('unavailable');
  }

  // Untrusted answer: the credit counts only once `creditsOf` shows it.
  const entry = Object.freeze({ amount, validBefore: Number(request.auth.validBefore) });
  flight.reserved.get(agentId)?.push(entry);
  const poll = deps.poll ?? DEFAULT_POLL;
  const sleep =
    deps.poll?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < poll.attempts; i += 1) {
    if (i > 0 && poll.intervalMs > 0) await sleep(poll.intervalMs);
    let after: bigint;
    try {
      after = await chain.state.creditsOf(agent, deployment.token);
    } catch {
      continue;
    }
    if (typeof after === 'bigint' && after - creditsBefore >= amount) {
      const list = flight.reserved.get(agentId) ?? [];
      flight.reserved.set(
        agentId,
        list.filter((r) => r !== entry),
      );
      deps.selector?.clear();
      return Object.freeze({ status: 'done' });
    }
  }
  return Object.freeze({ status: 'pending' });
}
