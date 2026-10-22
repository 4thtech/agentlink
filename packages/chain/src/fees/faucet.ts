// The testnet credits faucet's chain side (05 §9; 03 §4.4; 12 §4.1; audit-rules SUB-7; M1-10b).
//
// - Testnets only: `FAUCET_CHAIN_IDS` is a hard-coded allowlist, checked again by
//   `createFaucetChain` together with the config's `testnet` flag. Base Sepolia only until Gnosis
//   Chiado's smoke test has passed (M1-3j-b): adding Chiado is a reviewed code change here, never a
//   setting, and never against a predicted vault address.
// - `buildDepositFor` builds the calls a funder sends to top up another agent's credits: for a
//   stablecoin an `approve` of exactly the amount to the vault (never an unlimited allowance), then
//   `depositFor(agent, token, amount)`; for the native coin (xDAI on Gnosis) one `depositFor`
//   carrying the value.
// - `createFaucetChain` is the faucet wallet. Its key is the Worker secret of that chain, separate
//   from the gas key (release §4.5; I-7: never logged, never in an error, never on the returned
//   object). It signs locally through viem's account, in this package only (M0-10). It holds only
//   testnet funds. Nothing is signed until every check passed (chain ID, balances, simulation).
// - Every gas limit comes from a simulation (M1-10b-b). A `depositFor` that needs an `approve`
//   first cannot be simulated before that approve is mined, so the faucet sends the approve, waits
//   for its receipt (bounded), then simulates and sends the `depositFor`. An approve that is not
//   mined in time, or reverts, sends no `depositFor` (a leftover allowance serves the next claim).
// - Every gas limit is capped at `FAUCET_MAX_GAS` (M1-10b-c): a simulation above it is refused, not
//   clamped (a clamped limit could run out of gas and still spend the fee), and nothing is sent.
// - A stuck approve (one still in the mempool, so the faucet key's `pending` nonce is above its
//   `latest` one) would wedge every later claim behind it. Before sending an approve the faucet
//   compares the two and refuses with the retryable `busy`, sending nothing (M1-10b-c). The gap is
//   often only the previous claim's own `depositFor`, not yet mined, so the faucet first polls
//   `latest` until it reaches the `pending` nonce it read, and refuses only if it has not by the
//   deadline (M1-10b-d). The poll and the approve's receipt wait share one `receiptTimeoutMs`
//   budget per claim, so a claim waits no longer in total than before. A nonce found stuck at the
//   deadline is remembered: claims against the same nonce within FAUCET_STUCK_NONCE_COOLDOWN_MS
//   are refused at once, so a stuck approve does not hold the claim queue for a full budget each
//   time. A nonce that settles with less than FAUCET_MIN_APPROVE_BUDGET_SHARE of the budget left
//   is also `busy`: the approve would likely time out and stall the faucet on its own approve.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainConfigError, type ChainConfig, type FeeTokenSymbol } from '../config/index.js';
import { encodeFeeVaultCall } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../clients/read-client.js';
import { canonicalAddress, ChainInputError, type Hex } from '../ids/index.js';
import { createRpcCaller, RpcAnswerError, type AnyFetch, type FetchFn } from '../submitter/rpc.js';
import type { DepositStep } from './deposit.js';
import { offeredToken, offeredTokens } from './tokens.js';

/** The chains a faucet may serve: testnets only (SUB-7). Chiado (10200) joins with M1-3j-b (after its smoke test), together with its faucet configuration. */
export const FAUCET_CHAIN_IDS: readonly number[] = Object.freeze([84532]);

/**
 * The highest gas limit the faucet signs for any one transaction (simulated gas plus the margin).
 * An ERC-20 approve and a `depositFor` each need far less; a simulation above this cap is refused,
 * not clamped (M1-10b-c).
 */
export const FAUCET_MAX_GAS = 300_000n;

/**
 * After a pending nonce is found still stuck at the deadline, claims against the same nonce are
 * refused `busy` at once for this long, without polling: a stuck approve would otherwise hold the
 * serialised claim queue for a whole receipt budget per claim (IR-M1-10b-d-1 L1).
 */
export const FAUCET_STUCK_NONCE_COOLDOWN_MS = 60_000;

/**
 * The share of the receipt budget that must be left when a pending nonce settles for the faucet
 * to send its approve; with less, the approve would likely time out and the faucet stall behind
 * its own approve, so the claim is `busy` and nothing is sent (IR-M1-10b-d-1 L2).
 */
export const FAUCET_MIN_APPROVE_BUDGET_SHARE = 0.5;

/** The most one claim may credit, in US cents ($10). */
export const FAUCET_MAX_USD_CENTS = 1_000;

/** True only for a chain ID on the hard-coded faucet allowlist. */
export function isFaucetChain(chainId: unknown): boolean {
  return (
    typeof chainId === 'number' &&
    Number.isSafeInteger(chainId) &&
    FAUCET_CHAIN_IDS.includes(chainId)
  );
}

const MAX_UINT256 = 2n ** 256n - 1n;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const FAUCET_KEY = /^0x[0-9a-f]{64}$/;

export interface DepositForRequest {
  /** The agent whose credits are topped up. */
  readonly agent: string;
  readonly token: FeeTokenSymbol;
  /** Base units, 1 to 2^256 − 1. */
  readonly amount: bigint;
}

function checkAgent(agent: unknown): Hex {
  const address = canonicalAddress(agent, 'agent');
  if (address === ZERO_ADDRESS) {
    throw new ChainInputError('invalid_address', 'agent: must not be the zero address');
  }
  return address;
}

/** The calls that deposit `amount` of `token` as `agent`'s credits, sent by any funder. */
export function buildDepositFor(config: ChainConfig, request: DepositForRequest): DepositStep[] {
  const agent = checkAgent(request.agent);
  const { amount } = request;
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT256) {
    throw new ChainInputError('invalid_amount', 'amount: a bigint from 1 to 2^256 - 1');
  }
  const { token, vaultAddress } = offeredToken(config, request.token);
  const vault = config.contracts.vault;
  const deposit: DepositStep = Object.freeze({
    purpose: 'deposit',
    to: vault,
    data: encodeFeeVaultCall({ functionName: 'depositFor', args: [agent, vaultAddress, amount] }),
    value: token.address === null ? amount : 0n,
  });
  if (token.address === null) return [deposit];
  const approve: DepositStep = Object.freeze({
    purpose: 'approve',
    to: token.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }),
    value: 0n,
  });
  return [approve, deposit];
}

/** The outcome of one faucet credit. */
export type FaucetCredit =
  /** The `depositFor` transaction was accepted by the node; `txHash` is computed locally. */
  | { readonly state: 'sent'; readonly txHash: Hex }
  /** No `depositFor` was broadcast; nothing was credited. */
  | {
      readonly state: 'not_sent';
      /** `busy`: an earlier faucet transaction is still pending; retry later (M1-10b-c). */
      readonly reason: 'faucet_empty' | 'no_gas' | 'reverted' | 'unavailable' | 'busy';
    }
  /**
   * The `depositFor` broadcast lost its answer: it may or may not land. `txHash` is computed
   * locally from the signed bytes, so a retry can return it (M1-10b-b).
   */
  | { readonly state: 'unknown'; readonly txHash: Hex };

/** The faucet wallet of one testnet. */
export interface FaucetChain {
  readonly chainId: number;
  /** The faucet wallet's address (lowercase); public. */
  readonly faucetAddress: Hex;
  /**
   * Credits `agent` with `usdCents` of the chain's first fee token. Never throws for a chain or
   * RPC failure (see FaucetCredit); throws a ChainInputError for a bad agent or amount, before any
   * request.
   */
  credit(agent: Hex, usdCents: number): Promise<FaucetCredit>;
}

export interface FaucetChainOptions {
  /** The runtime's fetch (Workers). */
  readonly fetchFn: AnyFetch;
  /** The chain's faucet key: `0x` + 64 lowercase hex, from a Worker secret. */
  readonly faucetKey: string;
  /** The operator's RPC URLs (a Worker secret); default: the chain's shipped public URLs. */
  readonly rpcUrls?: readonly string[];
  /** Per-request timeout, 1 to 30 000 ms. */
  readonly timeoutMs?: number;
  /** An optional ceiling on `maxFeePerGas`, in wei. */
  readonly maxFeePerGasWei?: bigint;
  /** How often to ask for an approve's receipt, 1 to 10 000 ms (default 1 000). */
  readonly receiptPollMs?: number;
  /** How long to wait for an approve to be mined, 1 to 120 000 ms (default 30 000). */
  readonly receiptTimeoutMs?: number;
}

/** Added to every simulated gas amount (the submitter's FA-1 default margin). */
const GAS_MARGIN = 25_000n;
const DEFAULT_RECEIPT_POLL_MS = 1_000;
const DEFAULT_RECEIPT_TIMEOUT_MS = 30_000;

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as unknown as TimerGlobals).setTimeout(resolve, ms);
  });

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new ChainError('bad_answer');
  }
  return BigInt(value);
};

type NotSentReason = 'faucet_empty' | 'no_gas' | 'reverted' | 'unavailable' | 'busy';

class NotSent extends Error {
  readonly reason: NotSentReason;
  constructor(reason: NotSentReason) {
    super('not sent');
    this.reason = reason;
  }
}

/** Builds the faucet wallet for one allowlisted testnet. Rejections have fixed text. */
export function createFaucetChain(config: ChainConfig, options: FaucetChainOptions): FaucetChain {
  if (!isFaucetChain(config.chainId) || config.testnet !== true) {
    throw new ChainConfigError(
      'faucet_chain_refused',
      'the faucet serves allowlisted testnets only',
    );
  }
  if (typeof options.faucetKey !== 'string' || !FAUCET_KEY.test(options.faucetKey)) {
    // Never echo the key, not even a part of it.
    throw new ChainConfigError('bad_faucet_key', 'the faucet key must be 0x + 64 lowercase hex');
  }
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(options.faucetKey as Hex);
  } catch {
    throw new ChainConfigError('bad_faucet_key', 'the faucet key is not a valid key');
  }
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new ChainConfigError('bad_client_option', 'timeoutMs: 1 to 30000');
  }
  const pollMs = options.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10_000) {
    throw new ChainConfigError('bad_client_option', 'receiptPollMs: 1 to 10000');
  }
  const receiptTimeout = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(receiptTimeout) || receiptTimeout < 1 || receiptTimeout > 120_000) {
    throw new ChainConfigError('bad_client_option', 'receiptTimeoutMs: 1 to 120000');
  }
  const offered = offeredTokens(config)[0];
  if (offered === undefined) {
    throw new ChainConfigError('faucet_chain_refused', 'the chain offers no fee token');
  }
  const rpc = createRpcCaller(
    options.rpcUrls && options.rpcUrls.length > 0 ? options.rpcUrls : config.rpcUrls,
    options.fetchFn as unknown as FetchFn,
    timeout,
  );
  const chainId = config.chainId;
  const vault = config.contracts.vault.toLowerCase() as Hex;
  const faucetAddress = account.address.toLowerCase() as Hex;
  const tokenAddress = offered.token.address?.toLowerCase() as Hex | undefined;
  const unit = 10n ** BigInt(offered.token.decimals - 2);
  let chainChecked = false;
  /** The pending nonce last found stuck at a deadline, and when (IR-M1-10b-d-1 L1). */
  let stuck: { nonce: bigint; at: number } | null = null;

  /** A JSON-RPC read whose every failure is `unavailable`. */
  const read = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    try {
      return await rpc(method, params);
    } catch {
      throw new NotSent('unavailable');
    }
  };

  const readQuantity = async (method: string, params: readonly unknown[]): Promise<bigint> => {
    try {
      return quantity(await read(method, params));
    } catch (error) {
      if (error instanceof NotSent) throw error;
      throw new NotSent('unavailable');
    }
  };

  const erc20Read = async (functionName: 'balanceOf' | 'allowance', args: readonly Hex[]) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName, args } as never);
    const raw = await read('eth_call', [{ to: tokenAddress, data }, 'latest']);
    try {
      return decodeFunctionResult({ abi: erc20Abi, functionName, data: raw as Hex }) as bigint;
    } catch {
      throw new NotSent('unavailable');
    }
  };

  /**
   * Simulated gas plus the margin, at most FAUCET_MAX_GAS; a revert is `reverted`, anything else
   * (including a figure above the cap) `unavailable`.
   */
  const estimate = async (step: DepositStep): Promise<bigint> => {
    let raw: unknown;
    try {
      raw = await rpc('eth_estimateGas', [
        {
          from: faucetAddress,
          to: step.to,
          data: step.data,
          value: `0x${step.value.toString(16)}`,
        },
      ]);
    } catch (error) {
      if (error instanceof RpcAnswerError && error.data !== undefined) {
        throw new NotSent('reverted');
      }
      throw new NotSent('unavailable');
    }
    let gas: bigint;
    try {
      gas = quantity(raw) + GAS_MARGIN;
    } catch {
      throw new NotSent('unavailable');
    }
    if (gas > FAUCET_MAX_GAS) throw new NotSent('unavailable');
    return gas;
  };

  const sign = async (
    step: DepositStep,
    nonce: number,
    gas: bigint,
    fees: { maxFee: bigint; priority: bigint },
  ): Promise<Hex> => {
    try {
      return (await account.signTransaction({
        type: 'eip1559',
        chainId,
        nonce,
        gas,
        maxFeePerGas: fees.maxFee,
        maxPriorityFeePerGas: fees.priority,
        to: step.to as Hex,
        data: step.data,
        value: step.value,
      })) as Hex;
    } catch {
      throw new NotSent('unavailable');
    }
  };

  /** Broadcasts; 'refused' when the node answered with an error, 'lost' when no answer came. */
  const broadcast = async (raw: Hex): Promise<'ok' | 'refused' | 'lost'> => {
    try {
      await rpc('eth_sendRawTransaction', [raw]);
      return 'ok';
    } catch (error) {
      return error instanceof RpcAnswerError ? 'refused' : 'lost';
    }
  };

  /**
   * Waits until the `latest` nonce reaches `pendingNonce` (the transactions before it are mined);
   * still behind at `deadline` is `busy` (M1-10b-d). A failed poll is retried until the deadline.
   */
  const settled = async (pendingNonce: bigint, deadline: number): Promise<void> => {
    for (;;) {
      if (Date.now() + pollMs > deadline) throw new NotSent('busy');
      await sleep(pollMs);
      let latestNonce: bigint;
      try {
        latestNonce = await readQuantity('eth_getTransactionCount', [faucetAddress, 'latest']);
      } catch {
        continue;
      }
      if (latestNonce >= pendingNonce) return;
    }
  };

  /**
   * Waits until `txHash` is mined with status 1; anything else (reverted, too slow, past
   * `deadline`) is not sent.
   */
  const mined = async (txHash: Hex, deadline: number): Promise<void> => {
    for (;;) {
      let receipt: unknown;
      try {
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
      } catch {
        receipt = null; // a failed poll is retried until the deadline
      }
      if (receipt !== null && typeof receipt === 'object') {
        if ((receipt as { status?: unknown }).status === '0x1') return;
        throw new NotSent('unavailable');
      }
      if (Date.now() + pollMs > deadline) throw new NotSent('unavailable');
      await sleep(pollMs);
    }
  };

  const credit = async (agent: Hex, usdCents: number): Promise<FaucetCredit> => {
    const target = checkAgent(agent);
    if (!Number.isSafeInteger(usdCents) || usdCents < 1 || usdCents > FAUCET_MAX_USD_CENTS) {
      throw new ChainInputError('invalid_amount', `usdCents: 1 to ${String(FAUCET_MAX_USD_CENTS)}`);
    }
    const amount = BigInt(usdCents) * unit;
    const [approve, deposit] = (() => {
      const steps = buildDepositFor(config, {
        agent: target,
        token: offered.token.symbol,
        amount,
      });
      return steps.length === 2 ? [steps[0], steps[1]] : [undefined, steps[0]];
    })();
    if (deposit === undefined) return { state: 'not_sent', reason: 'unavailable' };

    try {
      if (!chainChecked) {
        // EIP-155 binds the signature to chainId anyway; this refuses a misconfigured RPC early.
        if ((await readQuantity('eth_chainId', [])) !== BigInt(chainId)) {
          throw new NotSent('unavailable');
        }
        chainChecked = true;
      }
      const native = await readQuantity('eth_getBalance', [faucetAddress, 'latest']);
      let needsApprove = false;
      if (approve !== undefined) {
        if ((await erc20Read('balanceOf', [faucetAddress])) < amount) {
          throw new NotSent('faucet_empty');
        }
        needsApprove = (await erc20Read('allowance', [faucetAddress, vault])) < amount;
      } else if (native < amount) {
        throw new NotSent('faucet_empty');
      }
      const block = (await read('eth_getBlockByNumber', ['latest', false])) as {
        baseFeePerGas?: unknown;
      } | null;
      if (block === null || typeof block !== 'object') throw new NotSent('unavailable');
      let baseFee: bigint;
      try {
        baseFee = quantity(block.baseFeePerGas);
      } catch {
        throw new NotSent('unavailable');
      }
      let priority = await readQuantity('eth_maxPriorityFeePerGas', []);
      let maxFee = 2n * baseFee + priority;
      if (options.maxFeePerGasWei !== undefined && maxFee > options.maxFeePerGasWei) {
        maxFee = options.maxFeePerGasWei;
        if (priority > maxFee) priority = maxFee;
      }
      const fees = { maxFee, priority };
      const valueSent = approve === undefined ? amount : 0n;

      const firstNonce = await readQuantity('eth_getTransactionCount', [faucetAddress, 'pending']);
      if (firstNonce > BigInt(Number.MAX_SAFE_INTEGER - 2)) throw new NotSent('unavailable');
      let nonce = Number(firstNonce);
      let spent = 0n;

      if (needsApprove && approve !== undefined) {
        // One budget for every wait of this claim: the nonce poll and the approve's receipt.
        const deadline = Date.now() + receiptTimeout;
        // A transaction still pending (latest nonce below the pending one) is either the previous
        // claim's depositFor, about to be mined, or an earlier approve that was not: a new approve
        // would queue behind it and wedge every later claim. Wait for it within the budget, then
        // refuse, retryable, and send nothing (M1-10b-c, M1-10b-d). The pending nonce is read
        // before the latest one, so a race can only give a false `busy`, never a missed one.
        const latestNonce = await readQuantity('eth_getTransactionCount', [
          faucetAddress,
          'latest',
        ]);
        if (firstNonce > latestNonce) {
          const now = Date.now();
          if (
            stuck !== null &&
            stuck.nonce === firstNonce &&
            now >= stuck.at &&
            now - stuck.at < FAUCET_STUCK_NONCE_COOLDOWN_MS
          ) {
            throw new NotSent('busy');
          }
          try {
            await settled(firstNonce, deadline);
          } catch (error) {
            if (error instanceof NotSent && error.reason === 'busy') {
              stuck = { nonce: firstNonce, at: Date.now() };
            }
            throw error;
          }
          stuck = null;
          // Too little budget left for the approve's receipt: refuse rather than stall on it.
          if (deadline - Date.now() < receiptTimeout * FAUCET_MIN_APPROVE_BUDGET_SHARE) {
            throw new NotSent('busy');
          }
        }
        // The depositFor pulls the token with the allowance, so it can be simulated only once the
        // approve is mined. A failed, lost, reverted or slow approve sends no depositFor: nothing
        // was credited (a leftover allowance is used by the next claim).
        const approveGas = await estimate(approve);
        spent = approveGas * maxFee;
        if (native < spent) throw new NotSent('no_gas');
        const raw = await sign(approve, nonce, approveGas, fees);
        if ((await broadcast(raw)) !== 'ok') throw new NotSent('unavailable');
        await mined(keccak256(raw) as Hex, deadline);
        nonce += 1;
      }

      const depositGas = await estimate(deposit);
      const depositCost = depositGas * maxFee;
      if (native < spent + depositCost + valueSent) {
        throw new NotSent(
          approve === undefined && native >= depositCost ? 'faucet_empty' : 'no_gas',
        );
      }
      const raw = await sign(deposit, nonce, depositGas, fees);
      const answer = await broadcast(raw);
      const txHash = keccak256(raw) as Hex;
      if (answer === 'ok') return { state: 'sent', txHash };
      if (answer === 'refused') return { state: 'not_sent', reason: 'unavailable' };
      return { state: 'unknown', txHash };
    } catch (error) {
      if (error instanceof NotSent) return { state: 'not_sent', reason: error.reason };
      return { state: 'not_sent', reason: 'unavailable' };
    }
  };

  return Object.freeze({ chainId, faucetAddress, credit });
}
