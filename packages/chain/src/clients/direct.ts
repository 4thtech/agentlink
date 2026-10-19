// Direct mode (07 §6.2; 03 §4.3; M1-4c): the agent's own account sends a Notary or vault call and
// pays the gas in the chain's native coin. The submitter is a convenience, never a requirement.
//
// - No key reaches this package (I-1, 04 §2.2). A `DirectSigner` signs one EIP-1559 transaction
//   that this module built; the bytes it returns are parsed and must be exactly that transaction,
//   from exactly the signer's address, or nothing is broadcast (`signer_mismatch`).
// - Every call is one of the direct-mode functions (state.ts) and is simulated from the signer
//   before it is signed: a revert is returned by name and nothing is signed.
// - A missing native balance for the worst-case gas cost is `no_gas`, decided before signing.
// - The transaction hash is computed from the signed bytes, never taken from an RPC answer.
// - Broadcasting goes through the platform's address-checked fetch to the same RPC URLs as reads
//   (user first, then shipped), sending only `eth_sendRawTransaction`. URLs are secrets: no error
//   names one.
import { encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { ChainConfigError, type ChainConfig } from '../config/index.js';
import type { Hex } from '../ids/index.js';
import { createRpcCaller, RpcAnswerError, type AnyFetch, type FetchFn } from '../submitter/rpc.js';
import { isAddressCheckedFetch } from './checked-fetch.js';
import { ChainError } from './errors.js';
import { DEFAULT_RPC_TIMEOUT_MS, MAX_USER_RPC_URLS } from './read-client.js';
import { checkDirectCall, directAbi, type ChainState, type ContractTx } from './state.js';

/** The transaction a DirectSigner is asked to sign. */
export interface DirectTransaction {
  readonly type: 'eip1559';
  readonly chainId: number;
  readonly nonce: number;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly to: Hex;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * Signs direct-mode transactions with the agent's EVM key (the KeyStore side; the key never
 * leaves it). `address` is the agent's EVM address, lowercase.
 */
export interface DirectSigner {
  readonly address: Hex;
  /** The serialized, signed transaction (`0x02…`). */
  signTransaction(tx: DirectTransaction): Promise<Hex>;
}

/** Sends signed bytes to the chain. */
export type Broadcast = (raw: Hex) => Promise<void>;

export interface DirectMode {
  readonly signer: DirectSigner;
  readonly broadcast: Broadcast;
}

export interface BroadcasterOptions {
  /** The platform's address-checked fetch (Node: nodeRpcFetch). */
  readonly fetchFn: AnyFetch;
  /** The user's own RPC URLs for this chain, tried first; at most 5. */
  readonly rpcUrls?: readonly string[];
  readonly timeoutMs?: number;
}

/** A broadcaster for one chain. Rejections are fixed-text ChainErrors. */
export function createBroadcaster(config: ChainConfig, options: BroadcasterOptions): Broadcast {
  if (!isAddressCheckedFetch(options.fetchFn)) {
    throw new ChainConfigError(
      'unchecked_fetch',
      'fetchFn: must be the platform address-checked RPC fetch (Node: nodeRpcFetch)',
    );
  }
  const own = options.rpcUrls ?? [];
  if (own.length > MAX_USER_RPC_URLS) {
    throw new ChainConfigError('too_many_rpc_urls', 'at most 5 own RPC URLs');
  }
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new ChainConfigError('bad_client_option', 'timeoutMs: 1 to 30000');
  }
  const rpc = createRpcCaller(
    [...own, ...config.rpcUrls],
    options.fetchFn as unknown as FetchFn,
    timeout,
  );
  return async (raw: Hex) => {
    try {
      await rpc('eth_sendRawTransaction', [raw]);
    } catch (error) {
      if (error instanceof ChainError) throw error;
      if (error instanceof RpcAnswerError) throw new ChainError('rpc_error');
      throw new ChainError('rpc_failed');
    }
  };
}

export type DirectSend =
  | { readonly ok: true; readonly txHash: Hex }
  /** The contract's refusal in simulation (by name), or `no_gas`. Nothing was signed. */
  | { readonly ok: false; readonly error: string };

export interface DirectSendOptions {
  /** An optional ceiling on `maxFeePerGas`, in wei. */
  readonly maxFeePerGasWei?: bigint;
}

/** Gas limit: the simulated gas plus 20 %. */
const withMargin = (gas: bigint): bigint => gas + gas / 5n;

/** Simulates, signs, checks and broadcasts one direct-mode call from the signer's account. */
export async function sendDirect(
  state: ChainState,
  direct: DirectMode,
  call: Omit<ContractTx, 'from'>,
  options: DirectSendOptions = {},
): Promise<DirectSend> {
  checkDirectCall(call);
  const from = direct.signer.address.toLowerCase() as Hex;
  const tx: ContractTx = { ...call, from };
  const sim = await state.simulate(tx);
  if (!sim.ok) return Object.freeze({ ok: false, error: sim.error });

  const fees = await state.fees();
  let maxFeePerGas = fees.maxFeePerGas;
  let maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  if (options.maxFeePerGasWei !== undefined && maxFeePerGas > options.maxFeePerGasWei) {
    maxFeePerGas = options.maxFeePerGasWei;
  }
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  const gas = withMargin(sim.gas);
  const balance = await state.nativeBalance(from);
  if (balance < gas * maxFeePerGas + call.value) {
    return Object.freeze({ ok: false, error: 'no_gas' });
  }

  let data: Hex;
  try {
    data = encodeFunctionData({
      abi: directAbi(call.contract),
      functionName: call.functionName,
      args: call.args,
    } as never);
  } catch {
    throw new ChainError('invalid_call');
  }
  const want: DirectTransaction = Object.freeze({
    type: 'eip1559',
    chainId: state.config.chainId,
    nonce: await state.pendingNonce(from),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    to: call.to.toLowerCase() as Hex,
    data,
    value: call.value,
  });
  const raw = await direct.signer.signTransaction(want);
  await checkSigned(raw, want, from);
  await direct.broadcast(raw);
  return Object.freeze({ ok: true, txHash: keccak256(raw) as Hex });
}

/** The signed bytes must be exactly `want`, signed by `from`. */
async function checkSigned(raw: unknown, want: DirectTransaction, from: Hex): Promise<void> {
  try {
    if (typeof raw !== 'string' || !/^0x02[0-9a-fA-F]+$/.test(raw)) throw new Error('form');
    const got = parseTransaction(raw as Hex);
    const same =
      got.type === 'eip1559' &&
      got.chainId === want.chainId &&
      got.nonce === want.nonce &&
      got.gas === want.gas &&
      got.maxFeePerGas === want.maxFeePerGas &&
      got.maxPriorityFeePerGas === want.maxPriorityFeePerGas &&
      (got.to ?? '').toLowerCase() === want.to &&
      (got.data ?? '0x').toLowerCase() === want.data.toLowerCase() &&
      (got.value ?? 0n) === want.value &&
      (got.accessList ?? []).length === 0;
    if (!same) throw new Error('fields');
    const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
    if (signer.toLowerCase() !== from) throw new Error('signer');
  } catch {
    throw new ChainError('signer_mismatch');
  }
}

/** How long and how often the paid path polls chain state. */
export interface PollOptions {
  /** Between reads, 1 to 60 000 ms; default 2 000. */
  readonly pollMs?: number;
  /** Total wait per attempt, 0 to 600 000 ms; default 60 000. */
  readonly waitMs?: number;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface TimerGlobals {
  setTimeout(fn: () => void, ms: number): unknown;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as unknown as TimerGlobals).setTimeout(resolve, ms);
  });

/** Checked poll settings: the number of extra reads and the pause between them. */
export function pollPlan(options: PollOptions): {
  rounds: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
} {
  const pollMs = options.pollMs ?? 2_000;
  const waitMs = options.waitMs ?? 60_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) {
    throw new ChainConfigError('bad_client_option', 'pollMs: 1 to 60000');
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600_000) {
    throw new ChainConfigError('bad_client_option', 'waitMs: 0 to 600000');
  }
  return { rounds: Math.ceil(waitMs / pollMs), pollMs, sleep: options.sleep ?? defaultSleep };
}

/**
 * Reads `check` until it returns a value or the wait is over (then `undefined`). A failed read is
 * not an answer: it is read again on the next round.
 */
export async function pollChain<T>(
  check: () => Promise<T | undefined>,
  options: PollOptions,
): Promise<T | undefined> {
  const { rounds, pollMs, sleep } = pollPlan(options);
  for (let i = 0; ; i += 1) {
    try {
      const got = await check();
      if (got !== undefined) return got;
    } catch (error) {
      if (!(error instanceof ChainError)) throw error;
    }
    if (i >= rounds) return undefined;
    await sleep(pollMs);
  }
}

/** Waits for a transaction's receipt: `success`, `reverted`, or `pending` when the wait ran out. */
export async function waitForTx(
  state: ChainState,
  hash: Hex,
  options: PollOptions = {},
): Promise<'success' | 'reverted' | 'pending'> {
  const got = await pollChain(async () => {
    const s = await state.txStatus(hash);
    return s === 'pending' ? undefined : s;
  }, options);
  return got ?? 'pending';
}
