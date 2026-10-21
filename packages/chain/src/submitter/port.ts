// The submitter Worker's chain port (07 §7; 05 §3.2, §3.3; M1-10a): what the batching engine in
// apps/submitter needs from a chain, and its real implementation over JSON-RPC.
//
// - Simulation (`eth_call`, `eth_estimateGas`) and sending only through the client-safe Notary ABI:
//   `notarizeBatch` and `acknowledgeBatch`, always, so an item that lands elsewhere between
//   simulation and inclusion is skipped on-chain rather than reverting the transaction (05 §3.3).
// - The gas key is the Worker secret of this chain (I-7: never logged, never in an error, never on
//   the returned object). It signs transactions locally through viem's account, one of the 04 §8.1
//   allowlisted libraries, in this package only (M0-10: apps/submitter is not in the viem zone). It
//   is a hot key with a low balance (07 §7); it has no other use and holds no user funds.
// - The transaction hash is computed locally from the signed bytes, never taken from the RPC.
import { encodeHex0x, recordStructHash, type OccReceipt, type OccRecord } from '@4thtech-io/crypto';
import {
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainConfigError, type ChainConfig } from '../config/index.js';
import { FEE_VAULT_CLIENT_ABI, NOTARY_CLIENT_ABI } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../clients/read-client.js';
import type { Hex } from '../ids/index.js';
import { createRpcCaller, RpcAnswerError, type AnyFetch, type FetchFn } from './rpc.js';
import { itemSignatureMatches } from './signature.js';
import type { SubmitItem } from './wire.js';

/** One item's simulation (05 §3.3 submitter rule). */
export type ItemSimulation =
  /** `gas`: the item's own simulated gas (`eth_estimateGas` of a one-item batch). */
  | { readonly outcome: 'ok'; readonly gas: bigint }
  /** Already on-chain in identical form (FA-3): reported `skipped`, never transmitted. */
  | { readonly outcome: 'skipped' }
  /** The Notary is paused: the item is held, not failed. */
  | { readonly outcome: 'paused' }
  /** Any other failure, named by the contract error (`InsufficientCredits`) or `reverted`. */
  | { readonly outcome: 'failed'; readonly error: string };

export type BatchSimulation =
  | { readonly ok: true; readonly gas: bigint }
  | { readonly ok: false; readonly error: string; readonly paused: boolean };

/** A sent transaction's state; `outcomes` maps item IDs to their on-chain event. */
export type TxInclusion =
  | { readonly state: 'pending' }
  | { readonly state: 'reverted' }
  | {
      readonly state: 'included';
      readonly outcomes: ReadonlyMap<string, 'recorded' | 'skipped'>;
    };

export interface SendOptions {
  readonly gasLimit: bigint;
  readonly nonce: number;
  /**
   * Fee level in percent of the current market fee (default 100). A replacement of a stuck
   * transaction at the same nonce sends a higher level; the configured ceiling still applies.
   */
  readonly feePercent?: number;
}

/** What the submitter engine needs from one chain. Items in one call share a type. */
export interface SubmitterChain {
  readonly chainId: number;
  /** The Notary proxy (lowercase). */
  readonly notary: Hex;
  /** The gas wallet's address (lowercase); public. */
  readonly gasAddress: Hex;
  /** The local EOA check (signature.ts); a signer with code is checked by the Notary instead. */
  signatureMatches(item: SubmitItem): boolean;
  /** True when the address has code: an ERC-1271 account or an EIP-7702 delegation (FA-1). */
  hasCode(address: Hex): Promise<boolean>;
  simulateItem(item: SubmitItem): Promise<ItemSimulation>;
  simulateBatch(items: readonly SubmitItem[]): Promise<BatchSimulation>;
  /** The gas wallet's next nonce, counting transactions still in the mempool (`pending`). */
  pendingNonce(): Promise<number>;
  /** The gas wallet's next nonce, counting mined transactions only (`latest`; M1-10a-b). */
  latestNonce(): Promise<number>;
  /** Signs and sends one batch transaction with exactly these items; returns its hash. */
  send(items: readonly SubmitItem[], options: SendOptions): Promise<Hex>;
  inclusion(txHash: Hex): Promise<TxInclusion>;
  gasBalance(): Promise<bigint>;
}

export interface SubmitterChainOptions {
  /** The runtime's fetch (Workers). */
  readonly fetchFn: AnyFetch;
  /** The chain's gas key: `0x` + 64 lowercase hex, from a Worker secret. */
  readonly gasKey: string;
  /** The operator's RPC URLs (a Worker secret); default: the chain's shipped public URLs. */
  readonly rpcUrls?: readonly string[];
  /** Per-request timeout, 1 to 30 000 ms. */
  readonly timeoutMs?: number;
  /** An optional ceiling on `maxFeePerGas`, in wei. */
  readonly maxFeePerGasWei?: bigint;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const GAS_KEY = /^0x[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ERRORS_ABI: Abi = [...NOTARY_CLIENT_ABI, ...FEE_VAULT_CLIENT_ABI].filter(
  (entry) => entry.type === 'error',
) as Abi;

const recordArgs = (r: OccRecord) => ({
  signer: r.signer as Hex,
  envelopeHash: r.envelopeHash as Hex,
  recipientCommitment: r.recipientCommitment as Hex,
  parentRecordId: r.parentRecordId as Hex,
  appId: r.appId as Hex,
  kind: r.kind,
  feeToken: r.feeToken as Hex,
  maxFee: BigInt(r.maxFee),
  nonce: BigInt(r.nonce),
  deadline: BigInt(r.deadline),
});

const receiptArgs = (r: OccReceipt) => ({
  signer: r.signer as Hex,
  recordId: r.recordId as Hex,
  receiptType: r.receiptType,
  salt: r.salt as Hex,
  deadline: BigInt(r.deadline),
});

/** Calldata for `notarizeBatch` or `acknowledgeBatch` with exactly these items. */
export function batchCalldata(items: readonly SubmitItem[]): Hex {
  const first = items[0];
  if (!first || items.some((i) => i.type !== first.type)) {
    throw new ChainError('invalid_call');
  }
  const sigs = items.map((i) => i.signature);
  if (first.type === 'record') {
    return encodeFunctionData({
      abi: NOTARY_CLIENT_ABI,
      functionName: 'notarizeBatch',
      args: [
        items.map((i) => recordArgs((i as Extract<SubmitItem, { type: 'record' }>).record)),
        sigs,
      ],
    } as never);
  }
  return encodeFunctionData({
    abi: NOTARY_CLIENT_ABI,
    functionName: 'acknowledgeBatch',
    args: [
      items.map((i) => receiptArgs((i as Extract<SubmitItem, { type: 'receipt' }>).receipt)),
      sigs,
    ],
  } as never);
}

/** The contract error name in revert data, or `reverted`. */
/** An unknown record, as `getRecord` would decode it if the Notary returned instead of reverting. */
const ABSENT_RECORD = Object.freeze({
  signer: ZERO_ADDRESS as string,
  recordStructHash: `0x${'0'.repeat(64)}`,
  receiptAt: Object.freeze([]) as readonly bigint[],
});

function revertName(data: Hex | undefined): string {
  if (data === undefined || data === '0x') return 'reverted';
  try {
    const { errorName } = decodeErrorResult({ abi: ERRORS_ABI, data });
    return IDENTIFIER.test(errorName) && errorName !== 'Error' && errorName !== 'Panic'
      ? errorName
      : 'reverted';
  } catch {
    return 'reverted';
  }
}

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new ChainError('bad_answer');
  }
  return BigInt(value);
};

/** Builds the chain port for one served chain. Rejections are ChainErrors with fixed text. */
export function createSubmitterChain(
  config: ChainConfig,
  options: SubmitterChainOptions,
): SubmitterChain {
  if (typeof options.gasKey !== 'string' || !GAS_KEY.test(options.gasKey)) {
    // Never echo the key, not even a part of it.
    throw new ChainConfigError('bad_gas_key', 'the gas key must be 0x + 64 lowercase hex');
  }
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(options.gasKey as Hex);
  } catch {
    throw new ChainConfigError('bad_gas_key', 'the gas key is not a valid key');
  }
  const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new ChainConfigError('bad_client_option', 'timeoutMs: 1 to 30000');
  }
  const rpc = createRpcCaller(
    options.rpcUrls && options.rpcUrls.length > 0 ? options.rpcUrls : config.rpcUrls,
    options.fetchFn as unknown as FetchFn,
    timeout,
  );
  const chainId = config.chainId;
  const notary = config.contracts.notary.toLowerCase() as Hex;
  const gasAddress = account.address.toLowerCase() as Hex;
  let chainChecked = false;

  /** A JSON-RPC call whose every failure is a fixed-text ChainError. */
  const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    try {
      return await rpc(method, params);
    } catch (error) {
      if (error instanceof ChainError || error instanceof RpcAnswerError) throw error;
      throw new ChainError('rpc_failed');
    }
  };

  /**
   * `eth_estimateGas` of a Notary call from the gas address: the gas on success, else the revert
   * name. An RPC error without revert data is the infrastructure's (a provider limit, a node
   * fault), not the item's: it throws, so no item fails and no signer cools off for it.
   */
  const estimate = async (data: Hex): Promise<bigint | string> => {
    try {
      return quantity(
        await call('eth_estimateGas', [{ from: gasAddress, to: notary, data, value: '0x0' }]),
      );
    } catch (error) {
      if (error instanceof RpcAnswerError) {
        if (error.data === undefined) throw new ChainError('rpc_error');
        return revertName(error.data);
      }
      throw error;
    }
  };

  const getRecord = async (recordId: Hex) => {
    const data = encodeFunctionData({
      abi: NOTARY_CLIENT_ABI,
      functionName: 'getRecord',
      args: [recordId],
    } as never);
    let raw: unknown;
    try {
      raw = await call('eth_call', [{ to: notary, data }, 'latest']);
    } catch (error) {
      // The deployed Notary reverts RecordNotFound() for an unknown ID: that, and only that
      // revert, means "absent" (as the read client, clients/state.ts). Any other stays an error.
      if (error instanceof RpcAnswerError && revertName(error.data) === 'RecordNotFound') {
        return ABSENT_RECORD;
      }
      if (error instanceof RpcAnswerError) throw new ChainError('rpc_error');
      throw error;
    }
    if (typeof raw !== 'string') throw new ChainError('bad_answer');
    try {
      return decodeFunctionResult({
        abi: NOTARY_CLIENT_ABI,
        functionName: 'getRecord',
        data: raw as Hex,
      } as never) as unknown as {
        signer: string;
        recordStructHash: string;
        receiptAt: readonly bigint[];
      };
    } catch {
      throw new ChainError('bad_answer');
    }
  };

  const nonceAt = async (tag: 'pending' | 'latest'): Promise<number> => {
    const n = quantity(await call('eth_getTransactionCount', [gasAddress, tag]));
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainError('bad_answer');
    return Number(n);
  };

  const failedOrPaused = (name: string): ItemSimulation =>
    name === 'EnforcedPause'
      ? { outcome: 'paused' }
      : Object.freeze({ outcome: 'failed', error: name });

  const port: SubmitterChain = {
    chainId,
    notary,
    gasAddress,

    signatureMatches: (item) => itemSignatureMatches(chainId, notary, item),

    async hasCode(address) {
      const code = await call('eth_getCode', [address, 'latest']);
      if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) {
        throw new ChainError('bad_answer');
      }
      return code.length > 2;
    },

    async simulateItem(item) {
      if (item.type === 'record') {
        const stored = await getRecord(item.recordId);
        if (stored.signer.toLowerCase() !== ZERO_ADDRESS) {
          const mine = encodeHex0x(recordStructHash(item.record));
          return stored.recordStructHash.toLowerCase() === mine
            ? { outcome: 'skipped' }
            : { outcome: 'failed', error: 'RecordExists' };
        }
        const gas = await estimate(batchCalldata([item]));
        return typeof gas === 'bigint' ? { outcome: 'ok', gas } : failedOrPaused(gas);
      }
      const gas = await estimate(batchCalldata([item]));
      if (typeof gas === 'string') return failedOrPaused(gas);
      // The checks passed; the type already set means the batch would skip it (05 §3.3).
      const stored = await getRecord(item.recordId);
      const at = stored.receiptAt[item.receipt.receiptType - 1] ?? 0n;
      return at !== 0n ? { outcome: 'skipped' } : { outcome: 'ok', gas };
    },

    async simulateBatch(items) {
      const gas = await estimate(batchCalldata(items));
      return typeof gas === 'bigint'
        ? { ok: true, gas }
        : { ok: false, error: gas, paused: gas === 'EnforcedPause' };
    },

    pendingNonce: () => nonceAt('pending'),

    latestNonce: () => nonceAt('latest'),

    async send(items, { gasLimit, nonce, feePercent = 100 }) {
      if (!Number.isSafeInteger(feePercent) || feePercent < 100 || feePercent > 1_000) {
        throw new ChainError('invalid_call');
      }
      const data = batchCalldata(items);
      if (!chainChecked) {
        // EIP-155 binds the signature to chainId anyway; this refuses a misconfigured RPC early.
        if (quantity(await call('eth_chainId', [])) !== BigInt(chainId)) {
          throw new ChainError('bad_answer');
        }
        chainChecked = true;
      }
      const block = (await call('eth_getBlockByNumber', ['latest', false])) as {
        baseFeePerGas?: unknown;
      } | null;
      if (block === null || typeof block !== 'object') throw new ChainError('bad_answer');
      const baseFee = quantity(block.baseFeePerGas);
      const pct = BigInt(feePercent);
      let priority = (quantity(await call('eth_maxPriorityFeePerGas', [])) * pct) / 100n;
      let maxFee = (2n * baseFee * pct) / 100n + priority;
      if (options.maxFeePerGasWei !== undefined && maxFee > options.maxFeePerGasWei) {
        maxFee = options.maxFeePerGasWei;
        if (priority > maxFee) priority = maxFee;
      }
      let raw: Hex;
      try {
        raw = (await account.signTransaction({
          type: 'eip1559',
          chainId,
          nonce,
          gas: gasLimit,
          maxFeePerGas: maxFee,
          maxPriorityFeePerGas: priority,
          to: notary,
          data,
          value: 0n,
        })) as Hex;
      } catch {
        throw new ChainError('invalid_call');
      }
      const hash = keccak256(raw) as Hex;
      try {
        await call('eth_sendRawTransaction', [raw]);
      } catch (error) {
        if (error instanceof RpcAnswerError) throw new ChainError('rpc_error');
        throw error;
      }
      return hash;
    },

    async inclusion(txHash) {
      const receipt = (await call('eth_getTransactionReceipt', [txHash])) as {
        status?: unknown;
        logs?: unknown;
      } | null;
      if (receipt === null) return { state: 'pending' };
      if (typeof receipt !== 'object') throw new ChainError('bad_answer');
      if (receipt.status !== '0x1') return { state: 'reverted' };
      const outcomes = new Map<string, 'recorded' | 'skipped'>();
      const logs = Array.isArray(receipt.logs) ? (receipt.logs as unknown[]) : [];
      for (const entry of logs) {
        const log = entry as { address?: unknown; topics?: unknown; data?: unknown };
        if (typeof log.address !== 'string' || log.address.toLowerCase() !== notary) continue;
        let decoded: { eventName: string; args: Record<string, unknown> };
        try {
          decoded = decodeEventLog({
            abi: NOTARY_CLIENT_ABI,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data as Hex,
          }) as unknown as { eventName: string; args: Record<string, unknown> };
        } catch {
          continue;
        }
        const recordId = String(decoded.args.recordId).toLowerCase();
        switch (decoded.eventName) {
          case 'RecordNotarized':
            outcomes.set(recordId, 'recorded');
            break;
          case 'RecordSkipped':
            outcomes.set(recordId, 'skipped');
            break;
          case 'ReceiptRecorded':
            outcomes.set(`${recordId}:${String(decoded.args.receiptType)}`, 'recorded');
            break;
          case 'ReceiptSkipped':
            outcomes.set(`${recordId}:${String(decoded.args.receiptType)}`, 'skipped');
            break;
          default:
            break;
        }
      }
      return { state: 'included', outcomes };
    },

    async gasBalance() {
      return quantity(await call('eth_getBalance', [gasAddress, 'latest']));
    },
  };
  return Object.freeze(port);
}
