// The chain-state port (07 §6.2; 04 §5, §7; M1-4c): the reads that every paid-path decision rests
// on, over the read client. A submitter's answer is never one of them: whether a Record or Receipt
// is on-chain, whether a transaction was included and whether a replacement may be signed are read
// here, from the chain, through the configured RPCs.
//
// - Reads only. Simulation (`eth_call`, `eth_estimateGas`) is bound to the few client functions the
//   direct path sends: `notarizeDirect`, `notarizeBatch`, `acknowledge` and `acknowledgeBatch` on
//   the Notary, `deposit` and `withdraw` (M1-4c-b) on the vault and `approve` on a fee token.
//   Anything else is refused before any request (`depositWithAuthorization` is not even in the
//   client ABI, D-89).
// - Every rejection is a fixed-text ChainError (the read client's view guarantees it): never a URL,
//   revert text or server text.
import { erc20Abi, type Abi } from 'viem';
import type { ChainConfig } from '../config/index.js';
import type { Hex } from '../ids/index.js';
import { FEE_VAULT_CLIENT_ABI, NOTARY_CLIENT_ABI } from './calls.js';
import { ChainError } from './errors.js';
import type { ReadClient } from './read-client.js';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/** `getRecord` as the client reads it; `null` only for the Notary's `RecordNotFound` revert. */
export interface StoredRecord {
  readonly signer: Hex;
  readonly recordStructHash: Hex;
  /** Timestamps for DELIVERED, OPENED, ACCEPTED, REJECTED; 0 where the type is not set. */
  readonly receiptAt: readonly bigint[];
}

export interface BlockInfo {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/** The contracts the direct path calls. */
export type ContractName = 'notary' | 'vault' | 'erc20';

/** One call the agent's own account may send in direct mode. */
export interface ContractTx {
  readonly contract: ContractName;
  readonly to: Hex;
  /** The sender; set by the direct path to the signer's address. */
  readonly from: Hex;
  readonly value: bigint;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

export type TxSimulation =
  | { readonly ok: true; readonly gas: bigint }
  /** `error`: the contract error name (`InsufficientCredits`), or `reverted` when unnamed. */
  | { readonly ok: false; readonly error: string };

export interface FeeLevels {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** What the paid path reads from one chain. Rejections are ChainErrors. */
export interface ChainState {
  readonly config: ChainConfig;
  /**
   * `getRecord` at `blockNumber` (default: latest): `null` only for a `RecordNotFound` revert; a
   * zero-signer struct is ChainError `bad_answer` (fail closed, M1-4c-d).
   */
  getRecord(recordId: Hex, blockNumber?: bigint): Promise<StoredRecord | null>;
  block(tag: 'latest' | 'finalized' | bigint): Promise<BlockInfo>;
  /** A transaction's receipt status; `pending` while there is no receipt. */
  txStatus(hash: Hex): Promise<'pending' | 'success' | 'reverted'>;
  /** Simulates one allowed call from `tx.from`: the revert name, or the estimated gas. */
  simulate(tx: ContractTx): Promise<TxSimulation>;
  fees(): Promise<FeeLevels>;
  /** The account's next nonce, counting pending transactions. */
  pendingNonce(address: Hex): Promise<number>;
  nativeBalance(address: Hex): Promise<bigint>;
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
  /** The vault's `minDeposit(token)` (the gasless top-up floor, 05 §2.2). */
  minDeposit(token: Hex): Promise<bigint>;
  creditsOf(payer: Hex, token: Hex): Promise<bigint>;
  /** An ERC-20 fee token's `balanceOf(owner)`. */
  tokenBalance(token: Hex, owner: Hex): Promise<bigint>;
}

/** The functions the direct path may send, per contract. */
const DIRECT_FUNCTIONS: Readonly<Record<ContractName, readonly string[]>> = Object.freeze({
  notary: Object.freeze(['notarizeDirect', 'notarizeBatch', 'acknowledge', 'acknowledgeBatch']),
  // `withdraw` (M1-4c-b): through sendWithdraw only, the agent's own credits to its own account;
  // the KeyStore refuses any other recipient.
  vault: Object.freeze(['deposit', 'withdraw']),
  erc20: Object.freeze(['approve']),
});

/** The ABI a direct call is encoded and decoded with (both OCC ABIs carry every OCC error). */
export function directAbi(contract: ContractName): Abi {
  switch (contract) {
    case 'notary':
      return NOTARY_CLIENT_ABI as Abi;
    case 'vault':
      return FEE_VAULT_CLIENT_ABI as Abi;
    case 'erc20':
      return erc20Abi as Abi;
  }
}

/** Refuses anything outside the direct-mode set (ChainError `invalid_call`), before any request. */
export function checkDirectCall(tx: Pick<ContractTx, 'contract' | 'functionName'>): void {
  const allowed = Object.hasOwn(DIRECT_FUNCTIONS, tx.contract)
    ? DIRECT_FUNCTIONS[tx.contract]
    : undefined;
  if (!allowed?.includes(tx.functionName)) throw new ChainError('invalid_call');
}

const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new ChainError('bad_answer');
  return BigInt(value);
}

const toBlockParam = (tag: 'latest' | 'finalized' | bigint): string =>
  typeof tag === 'bigint' ? `0x${tag.toString(16)}` : tag;

/** The chain-state port over a read client (see ChainReader). */
export function createChainState(reader: {
  readonly config: ChainConfig;
  readonly client: ReadClient;
}): ChainState {
  const { config, client } = reader;
  const notary = config.contracts.notary as Hex;
  const vault = config.contracts.vault as Hex;
  const request = client.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;

  const read = <T>(args: {
    address: Hex;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<T> => client.readContract(args as never) as Promise<T>;

  return Object.freeze({
    config,

    async getRecord(recordId: Hex, blockNumber?: bigint) {
      let raw: { signer: string; recordStructHash: string; receiptAt: readonly bigint[] };
      try {
        raw = await read({
          address: notary,
          abi: NOTARY_CLIENT_ABI as Abi,
          functionName: 'getRecord',
          args: [recordId],
          ...(blockNumber === undefined ? {} : { blockNumber }),
        });
      } catch (error) {
        // The deployed Notary reverts `RecordNotFound()` for an unknown ID: that, and only that
        // revert, means "absent". Any other failure stays a failure, so nothing is decided on it.
        if (
          error instanceof ChainError &&
          error.code === 'call_reverted' &&
          error.revertName === 'RecordNotFound'
        ) {
          return null;
        }
        throw error;
      }
      // The Notary never answers with an empty slot (an unknown ID reverts, above). A struct with a
      // zero signer is a misbehaving RPC or contract: a bad answer, never "absent", so no
      // replacement is signed and nothing is sent on it (M1-4c-d; 04 §5).
      if (raw.signer.toLowerCase() === ZERO_ADDRESS) {
        throw new ChainError('bad_answer');
      }
      return Object.freeze({
        signer: raw.signer.toLowerCase() as Hex,
        recordStructHash: raw.recordStructHash.toLowerCase() as Hex,
        receiptAt: Object.freeze([...raw.receiptAt]),
      });
    },

    async block(tag: 'latest' | 'finalized' | bigint) {
      const b = (await request({
        method: 'eth_getBlockByNumber',
        params: [toBlockParam(tag), false],
      })) as { number?: unknown; timestamp?: unknown } | null;
      if (b === null || typeof b !== 'object') throw new ChainError('bad_answer');
      return Object.freeze({ number: quantity(b.number), timestamp: quantity(b.timestamp) });
    },

    async txStatus(hash: Hex) {
      const r = (await request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      })) as { status?: unknown } | null;
      if (r === null) return 'pending';
      if (typeof r !== 'object') throw new ChainError('bad_answer');
      if (r.status === '0x1') return 'success';
      if (r.status === '0x0') return 'reverted';
      throw new ChainError('bad_answer');
    },

    async simulate(tx: ContractTx): Promise<TxSimulation> {
      checkDirectCall(tx);
      const call = {
        address: tx.to,
        abi: directAbi(tx.contract),
        functionName: tx.functionName,
        args: tx.args,
        account: tx.from,
        ...(tx.value === 0n ? {} : { value: tx.value }),
      };
      try {
        await client.simulateContract(call as never);
      } catch (error) {
        if (error instanceof ChainError && error.code === 'call_reverted') {
          return Object.freeze({ ok: false, error: error.revertName ?? 'reverted' });
        }
        throw error;
      }
      const gas = await client.estimateContractGas(call as never);
      return Object.freeze({ ok: true, gas });
    },

    async fees() {
      const f = await client.estimateFeesPerGas({ type: 'eip1559' });
      if (f.maxFeePerGas === undefined || f.maxPriorityFeePerGas === undefined) {
        throw new ChainError('bad_answer');
      }
      return Object.freeze({
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      });
    },

    async pendingNonce(address: Hex) {
      const n = await client.getTransactionCount({ address, blockTag: 'pending' });
      if (!Number.isSafeInteger(n) || n < 0) throw new ChainError('bad_answer');
      return n;
    },

    nativeBalance: (address: Hex) => client.getBalance({ address }),

    allowance: (token: Hex, owner: Hex, spender: Hex) =>
      read<bigint>({
        address: token,
        abi: erc20Abi as Abi,
        functionName: 'allowance',
        args: [owner, spender],
      }),

    minDeposit: (token: Hex) =>
      read<bigint>({
        address: vault,
        abi: FEE_VAULT_CLIENT_ABI as Abi,
        functionName: 'minDeposit',
        args: [token],
      }),

    tokenBalance: (token: Hex, owner: Hex) =>
      read<bigint>({
        address: token,
        abi: erc20Abi as Abi,
        functionName: 'balanceOf',
        args: [owner],
      }),

    creditsOf: (payer: Hex, token: Hex) =>
      read<bigint>({
        address: vault,
        abi: FEE_VAULT_CLIENT_ABI as Abi,
        functionName: 'creditsOf',
        args: [payer, token],
      }),
  } satisfies ChainState);
}
