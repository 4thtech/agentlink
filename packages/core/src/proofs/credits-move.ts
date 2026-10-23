// Add credits by QR on Chiado, and withdraw credits (M1-11c-a4c; D-122, D-123; 12 §4.1, §4.4;
// 05 §2.5; 04 §2.5, §2.5.1; 07 §6.2).
//
// - `readTopUp`: where the agent can be paid. On a top-up chain (Gnosis Chiado only for now, D-123:
//   its fee asset is native xDAI, which is also what pays the network cost) the agent's own address
//   receives xDAI by a plain transfer; this reads what the account holds, how much of it can become
//   credits once the gas reserve is kept, and the credits it can withdraw. Any other testnet is
//   "coming soon" (Base Sepolia waits for the gasless top-up, M1-3c). A mainnet is never listed.
//   Reads only: no key is used and direct mode is never asked for.
// - `addReceivedFunds`: after a fresh owner-signed `credits.deposit` (owner presence, 04 §2.5), the
//   agent's own `deposit{value}(address(0), amount)` on that chain, signed by its KeyStore (M1-4c-b)
//   and paid for from the same account. The amount is exactly the signed one, and the gas reserve
//   always stays: `amount + reserve <= balance`, or nothing is sent.
// - `withdrawCredits`: after a fresh owner-signed `credits.withdraw`, `withdraw(token, amount, to)`
//   with `to` the agent's own account, the only recipient allowed until the owner-signed recipient
//   grant exists (IR-M1-4c-b-1 M-1; the KeyStore refuses any other recipient too).
// - Order: the object checks (signature, agent, owner, freshness, nonce), then the chain, token,
//   amount and recipient rules against a fresh read, then the nonce is recorded (each object applies
//   once), then direct mode is built and the call sent. A refusal before the nonce record writes
//   nothing; a failure after it needs a new owner confirmation.
// - Results are fixed words. Never a transaction hash, address, key, URL or error text (I-7);
//   failures are logged as fixed codes only.
import type { ChainState, Hex, PollOptions } from '@4thtech-io/chain';
import type { CoreContext } from '../context.js';
import type { OwnerActionRefusal } from '../owner-action.js';
import type { OwnerActions } from '../owner-actions.js';
import type { ProofChain, ProofsPlatform } from './platform.js';

/** The chains where funds sent to the agent's address can become credits (D-123: Chiado now). */
export const TOP_UP_CHAIN_IDS: readonly number[] = Object.freeze([10200]);

/**
 * What stays in the agent's account after turning received funds into credits: 0.01 xDAI. A Chiado
 * `deposit` or `withdraw` costs well under 0.0001 xDAI at 1 gwei, so the reserve pays for many later
 * withdrawals, and a withdrawal never strands credits for lack of a network fee.
 */
export const TOP_UP_GAS_RESERVE_WEI = 10n ** 16n;

/** The least that is turned into credits at once: 0.1 xDAI, the price of one proof. */
export const TOP_UP_MIN_WEI = 10n ** 17n;

/** How long a send waits for inclusion before it answers `pending` (within one HTTP request). */
const DEFAULT_POLL: PollOptions = Object.freeze({ pollMs: 2_000, waitMs: 20_000 });

/** An amount in base units and in dollars (rounded down; null above the USD range). */
export interface TopUpAmount {
  readonly amount: string;
  readonly usd: string | null;
}

export type TopUpChain =
  | { readonly chainId: number; readonly chain: string; readonly method: 'coming_soon' }
  | {
      readonly chainId: number;
      readonly chain: string;
      readonly method: 'address';
      /** False when the chain could not be read just now. */
      readonly available: false;
    }
  | {
      readonly chainId: number;
      readonly chain: string;
      readonly method: 'address';
      readonly available: true;
      /** The fee token the account receives (`NATIVE`: xDAI). */
      readonly token: 'NATIVE';
      /** What the agent's account holds. */
      readonly received: TopUpAmount;
      /** What can become credits now: the holdings less the reserve, or 0 below the minimum. */
      readonly addable: TopUpAmount;
      /** The agent's credits in that token, which it can withdraw. */
      readonly credits: TopUpAmount;
    };

export type TopUpView =
  | {
      readonly status: 'ok';
      /** The agent ID: the address funds are sent to on a top-up chain. */
      readonly agentId: string;
      readonly chains: readonly TopUpChain[];
    }
  | { readonly status: 'unavailable' };

/** Why a credits move was refused before anything was sent. */
export type CreditsMoveRefusal =
  | OwnerActionRefusal
  /** Not a top-up chain or token on this runtime (a mainnet included). */
  | 'not_available'
  /** Less than the minimum. */
  | 'below_minimum'
  /** The account or the credits do not hold the amount (with the reserve kept), just now. */
  | 'amount_unavailable'
  /** A withdrawal to anyone but the agent's own account (the recipient grant is a later card). */
  | 'recipient_not_allowed';

export type CreditsMoveResult =
  /** Included on-chain. */
  | { readonly status: 'done' }
  /** Sent; not included yet. The credits read shows it once it is. */
  | { readonly status: 'pending' }
  | { readonly status: 'refused'; readonly reason: CreditsMoveRefusal }
  | {
      readonly status: 'failed';
      /** `no_funds_for_fee`: the account cannot pay the network cost; `reverted`: the contract refused. */
      readonly reason: 'no_funds_for_fee' | 'reverted' | 'unavailable';
    };

const UNAVAILABLE = Object.freeze({ status: 'unavailable' as const });
const refusedWith = (reason: CreditsMoveRefusal): CreditsMoveResult =>
  Object.freeze({ status: 'refused', reason });
const failedWith = (reason: 'no_funds_for_fee' | 'reverted' | 'unavailable'): CreditsMoveResult =>
  Object.freeze({ status: 'failed', reason });

/** A top-up chain of this runtime: listed, a testnet, with direct mode and the native fee token. */
function topUpChain(platform: ProofsPlatform, chainId: number): ProofChain | undefined {
  if (!TOP_UP_CHAIN_IDS.includes(chainId)) return undefined;
  const chain = platform.chains.find((c) => c.config.chainId === chainId);
  if (chain === undefined || chain.config.testnet !== true || chain.directMode === undefined) {
    return undefined;
  }
  return nativeToken(platform, chain) === undefined ? undefined : chain;
}

function nativeToken(platform: ProofsPlatform, chain: ProofChain) {
  return platform.kit
    .offeredTokens(chain.config)
    .find((o) => o.token.symbol === 'NATIVE' && o.token.address === null);
}

function amountOf(platform: ProofsPlatform, amount: bigint, decimals: number): TopUpAmount {
  let usd: string | null;
  try {
    usd = platform.kit.tokenUnitsToUsd(amount, decimals, 'down');
  } catch {
    usd = null;
  }
  return Object.freeze({ amount: amount.toString(), usd });
}

/** The addable part of `balance`: less the reserve, or 0 below the minimum. */
const addableOf = (balance: bigint): bigint => {
  const left = balance - TOP_UP_GAS_RESERVE_WEI;
  return left >= TOP_UP_MIN_WEI ? left : 0n;
};

/** Where and how the agent can be paid, per testnet of the platform (reads only). */
export async function readTopUp(
  platform: ProofsPlatform | undefined,
  agentId: string | undefined,
): Promise<TopUpView> {
  if (platform === undefined || agentId === undefined) return UNAVAILABLE;
  const chains = await Promise.all(
    platform.chains
      .filter((c) => c.config.testnet === true)
      .map(async (chain): Promise<TopUpChain> => {
        const head = { chainId: chain.config.chainId, chain: chain.config.key };
        const top = topUpChain(platform, chain.config.chainId);
        const native = top === undefined ? undefined : nativeToken(platform, top);
        if (top === undefined || native === undefined) {
          return Object.freeze({ ...head, method: 'coming_soon' as const });
        }
        try {
          const [balance, credits] = await Promise.all([
            top.state.nativeBalance(agentId as Hex),
            top.state.creditsOf(agentId as Hex, native.vaultAddress as Hex),
          ]);
          const decimals = native.token.decimals;
          return Object.freeze({
            ...head,
            method: 'address' as const,
            available: true as const,
            token: 'NATIVE' as const,
            received: amountOf(platform, balance, decimals),
            addable: amountOf(platform, addableOf(balance), decimals),
            credits: amountOf(platform, credits, decimals),
          });
        } catch {
          // Never the error's text: it could name an RPC URL (07 §6.1).
          return Object.freeze({ ...head, method: 'address' as const, available: false as const });
        }
      }),
  );
  return Object.freeze({ status: 'ok' as const, agentId, chains: Object.freeze(chains) });
}

export interface CreditsMoveDeps {
  readonly ctx: CoreContext;
  readonly platform: ProofsPlatform | undefined;
  readonly ownerActions: OwnerActions;
  /** The agent's ID (its EVM address), or undefined before init. */
  readonly agentId: () => Promise<string | undefined>;
  /** The chain selector's cache, cleared once credits changed (07 §6.3). */
  readonly selector?: { clear(): void };
}

/** A ChainError's fixed code, by name (the core imports only types from the chain package). */
function chainCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (name === 'ChainError' || name === 'ChainConfigError') && typeof code === 'string'
    ? code
    : undefined;
}

function outcomeOf(error: unknown): CreditsMoveResult {
  switch (chainCode(error)) {
    case 'tx_not_included':
      return Object.freeze({ status: 'pending' });
    case 'no_gas':
      return failedWith('no_funds_for_fee');
    case 'call_reverted':
    case 'tx_reverted':
      return failedWith('reverted');
    case 'direct_mode_unavailable':
      return refusedWith('not_available');
    default:
      return failedWith('unavailable');
  }
}

function failure(deps: CreditsMoveDeps, what: string, error: unknown): CreditsMoveResult {
  const result = outcomeOf(error);
  // Fixed words only: never the error's text, an address or an amount (I-7).
  deps.ctx.log.warn('credits move not completed', {
    what,
    outcome: 'reason' in result ? result.reason : result.status,
  });
  return result;
}

/** The shared part: the object, the chain and the token, before any chain read. */
async function prepare(
  deps: CreditsMoveDeps,
  input: unknown,
  op: 'credits.deposit' | 'credits.withdraw',
) {
  const verified = await deps.ownerActions.verifyCredits(input, op);
  if (!verified.ok) return { result: refusedWith(verified.reason) } as const;
  const { signed, actionHash } = verified;
  const body = signed.body;
  if (body.op !== 'credits.deposit' && body.op !== 'credits.withdraw') {
    return { result: refusedWith('malformed') } as const;
  }
  const platform = deps.platform;
  const agentId = await deps.agentId();
  if (platform === undefined || agentId === undefined || body.agent !== agentId) {
    return { result: refusedWith('not_available') } as const;
  }
  const chain = topUpChain(platform, body.params.chainId);
  const native = chain === undefined ? undefined : nativeToken(platform, chain);
  if (chain === undefined || native === undefined || body.params.token !== 'NATIVE') {
    return { result: refusedWith('not_available') } as const;
  }
  return {
    signed,
    actionHash,
    platform,
    chain,
    native,
    agentId: agentId as Hex,
    amount: BigInt(body.params.amount),
  } as const;
}

async function sendOnce(
  deps: CreditsMoveDeps,
  prepared: Exclude<Awaited<ReturnType<typeof prepare>>, { result: unknown }>,
  what: 'deposit' | 'withdraw',
  send: (
    state: ChainState,
    direct: Awaited<ReturnType<NonNullable<ProofChain['directMode']>>>,
  ) => Promise<unknown>,
): Promise<CreditsMoveResult> {
  const { chain, signed, actionHash } = prepared;
  if (!(await deps.ownerActions.consumeCredits(signed, actionHash))) {
    return refusedWith('nonce_used');
  }
  const factory = chain.directMode;
  if (factory === undefined) return refusedWith('not_available');
  try {
    const direct = await factory(deps.ctx.keyStore);
    await send(chain.state, direct);
  } catch (error) {
    return failure(deps, what, error);
  } finally {
    // Credits may have changed: never pay from the cached detection (07 §6.3).
    deps.selector?.clear();
  }
  return Object.freeze({ status: 'done' });
}

const pollOf = (platform: ProofsPlatform): PollOptions => platform.directPoll ?? DEFAULT_POLL;

/** Turns funds the agent's account received into its own credits (owner-signed `credits.deposit`). */
export async function addReceivedFunds(
  deps: CreditsMoveDeps,
  input: unknown,
): Promise<CreditsMoveResult> {
  const prepared = await prepare(deps, input, 'credits.deposit');
  if ('result' in prepared) return prepared.result;
  const { platform, chain, agentId, amount } = prepared;
  if (amount < TOP_UP_MIN_WEI) return refusedWith('below_minimum');
  let balance: bigint;
  try {
    balance = await chain.state.nativeBalance(agentId);
  } catch {
    return failedWith('unavailable');
  }
  // The gas reserve always stays in the account.
  if (amount + TOP_UP_GAS_RESERVE_WEI > balance) return refusedWith('amount_unavailable');
  const request = { token: 'NATIVE' as const, amount };
  return sendOnce(deps, prepared, 'deposit', async (state, direct) => {
    const steps = platform.kit.buildDeposit(state.config, request);
    await platform.kit.sendDeposit(state, direct, request, steps, pollOf(platform));
  });
}

/** Withdraws the agent's credits to its own account (owner-signed `credits.withdraw`). */
export async function withdrawCredits(
  deps: CreditsMoveDeps,
  input: unknown,
): Promise<CreditsMoveResult> {
  const prepared = await prepare(deps, input, 'credits.withdraw');
  if ('result' in prepared) return prepared.result;
  const { platform, chain, native, agentId, amount, signed } = prepared;
  if (signed.body.op !== 'credits.withdraw') return refusedWith('malformed');
  // The agent's own account only, until the owner-signed recipient grant (IR-M1-4c-b-1 M-1).
  if (signed.body.params.to !== agentId) return refusedWith('recipient_not_allowed');
  let credits: bigint;
  try {
    credits = await chain.state.creditsOf(agentId, native.vaultAddress as Hex);
  } catch {
    return failedWith('unavailable');
  }
  if (amount > credits) return refusedWith('amount_unavailable');
  return sendOnce(deps, prepared, 'withdraw', async (state, direct) => {
    await platform.kit.sendWithdraw(state, direct, { token: 'NATIVE', amount }, pollOf(platform));
  });
}
