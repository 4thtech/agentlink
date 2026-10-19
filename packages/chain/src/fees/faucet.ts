// The testnet credits faucet's chain side (05 §9; 03 §4.4; 12 §4.1; audit-rules SUB-7; M1-10b).
//
// - Testnets only: `FAUCET_CHAIN_IDS` is a hard-coded allowlist, checked again by
//   `createFaucetChain` together with the config's `testnet` flag. Base Sepolia only until Gnosis
//   Chiado is deployed (M1-3j, D-63, D-92): adding Chiado is a reviewed code change here, never a
//   setting, and never against a predicted vault address.
// - `buildDepositFor` builds the calls a funder sends to top up another agent's credits: for a
//   stablecoin an `approve` of exactly the amount to the vault (never an unlimited allowance), then
//   `depositFor(agent, token, amount)`; for the native coin (xDAI on Gnosis) one `depositFor`
//   carrying the value.
// - `createFaucetChain` is the faucet wallet. Its key is the Worker secret of that chain, separate
//   from the gas key (release §4.5; I-7: never logged, never in an error, never on the returned
//   object). It signs locally through viem's account, in this package only (M0-10). It holds only
//   testnet funds. Nothing is signed until every check passed (chain ID, balances, simulation).
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

/** The chains a faucet may serve: testnets only (SUB-7). Chiado (10200) joins after M1-3j. */
export const FAUCET_CHAIN_IDS: readonly number[] = Object.freeze([84532]);

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
      readonly reason: 'faucet_empty' | 'no_gas' | 'reverted' | 'unavailable';
    }
  /** The `depositFor` broadcast lost its answer: it may or may not land. */
  | { readonly state: 'unknown' };

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
}

/** Added to every simulated gas amount (the submitter's FA-1 default margin). */
const GAS_MARGIN = 25_000n;
/**
 * The gas limit of a `depositFor` sent right after its `approve`, which cannot be simulated before
 * the approve is mined: a token transfer plus one credit update, with room to spare.
 */
const DEPOSIT_AFTER_APPROVE_GAS = 200_000n;

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new ChainError('bad_answer');
  }
  return BigInt(value);
};

class NotSent extends Error {
  readonly reason: 'faucet_empty' | 'no_gas' | 'reverted' | 'unavailable';
  constructor(reason: 'faucet_empty' | 'no_gas' | 'reverted' | 'unavailable') {
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

  /** Simulated gas plus the margin; a revert is `reverted`, anything else `unavailable`. */
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
    try {
      return quantity(raw) + GAS_MARGIN;
    } catch {
      throw new NotSent('unavailable');
    }
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
      const plan: { step: DepositStep; gas: bigint }[] = [];
      if (needsApprove && approve !== undefined) {
        plan.push({ step: approve, gas: await estimate(approve) });
        plan.push({ step: deposit, gas: DEPOSIT_AFTER_APPROVE_GAS });
      } else {
        plan.push({ step: deposit, gas: await estimate(deposit) });
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
      const gasCost = plan.reduce((sum, p) => sum + p.gas, 0n) * maxFee;
      const valueSent = approve === undefined ? amount : 0n;
      if (native < gasCost + valueSent) {
        throw new NotSent(approve === undefined && native >= gasCost ? 'faucet_empty' : 'no_gas');
      }

      const firstNonce = await readQuantity('eth_getTransactionCount', [faucetAddress, 'pending']);
      if (firstNonce > BigInt(Number.MAX_SAFE_INTEGER - 2)) throw new NotSent('unavailable');
      let nonce = Number(firstNonce);
      const signed: Hex[] = [];
      for (const p of plan) {
        signed.push(await sign(p.step, nonce, p.gas, { maxFee, priority }));
        nonce += 1;
      }
      // Only the depositFor credits anything: an approve that fails or loses its answer means no
      // credit was sent (a leftover allowance is used by the next claim).
      for (let i = 0; i < signed.length; i += 1) {
        const raw = signed[i] as Hex;
        const last = i === signed.length - 1;
        const answer = await broadcast(raw);
        if (answer === 'ok') {
          if (last) return { state: 'sent', txHash: keccak256(raw) as Hex };
          continue;
        }
        if (!last || answer === 'refused') return { state: 'not_sent', reason: 'unavailable' };
        return { state: 'unknown' };
      }
      return { state: 'not_sent', reason: 'unavailable' };
    } catch (error) {
      if (error instanceof NotSent) return { state: 'not_sent', reason: error.reason };
      return { state: 'not_sent', reason: 'unavailable' };
    }
  };

  return Object.freeze({ chainId, faucetAddress, credit });
}
