// An in-memory OCC v2 Notary and fee vault for the proof tests (M1-7g). It plays the chain behind
// the chain package's own ports, so the core runs the real chain code end to end:
// - `ChainState` (getRecord, blocks, simulation, credits) for `createProofSubmitter`;
// - a `SubmitterClient` that "mines" a simulated item at once;
// - a `ReadClient` (readContract, getCode) for `verifyProofPack` and the chain selector (quote,
//   creditsOf, balanceOf, minDeposit).
// The contract checks the fake applies are the 05 §3.2/§3.3 ones a test can observe: the EIP-712
// signature by the signer, the deadline, credits for the record fee, the recipient commitment for a
// receipt (`commitment(receipt.signer, salt)`), one-time receipt flags and ACCEPTED/REJECTED
// exclusivity. No network, no key: signatures come from the agents' MemoryKeyStores.
import {
  decodeEcdsaSignature,
  encodeHex0x,
  hashTypedData,
  occV2Domain,
  receiptTypedData,
  recipientCommitment,
  recordStructHash,
  recordTypedData,
  recoverEvmAddress,
  type OccReceipt,
  type OccRecord,
} from '@4thtech-io/crypto';
import * as chainKit from '@4thtech-io/chain';
import {
  computeRecordId,
  createProofSubmitter,
  getChainConfig,
  type BlockInfo,
  type ChainConfig,
  type ChainState,
  type ContractTx,
  type Hex,
  type ProofSubmitter,
  type ReadClient,
  type StoredRecord,
  type SubmitResponse,
  type SubmitterClient,
  type TxSimulation,
} from '@4thtech-io/chain';
import type { ProofChain, ProofsPlatform } from '../proofs/platform.js';

export const BASE_SEPOLIA = getChainConfig(84532) as ChainConfig;
export const USDC = BASE_SEPOLIA.feeTokens.find((t) => t.symbol === 'USDC')?.address as Hex;
/** The test fee: $0.10 in 6-decimal USDC. */
export const FEE_UNITS = 100_000n;

interface Stored {
  readonly record: OccRecord;
  readonly structHash: Hex;
  readonly timestamp: bigint;
  readonly receiptAt: bigint[];
}

const lower = (v: unknown): string => String(v).toLowerCase();

function recordOf(t: Record<string, unknown>): OccRecord {
  return {
    signer: lower(t.signer),
    envelopeHash: lower(t.envelopeHash),
    recipientCommitment: lower(t.recipientCommitment),
    parentRecordId: lower(t.parentRecordId),
    appId: lower(t.appId),
    kind: Number(t.kind),
    feeToken: lower(t.feeToken),
    maxFee: String(t.maxFee),
    nonce: String(t.nonce),
    deadline: Number(t.deadline),
  };
}

function receiptOf(t: Record<string, unknown>): OccReceipt {
  return {
    signer: lower(t.signer),
    recordId: lower(t.recordId),
    receiptType: Number(t.receiptType),
    salt: lower(t.salt),
    deadline: Number(t.deadline),
  };
}

function recovers(digest: Uint8Array, signature: string, signer: string): boolean {
  try {
    return encodeHex0x(recoverEvmAddress(digest, decodeEcdsaSignature(signature))) === signer;
  } catch {
    return false;
  }
}

/** The in-memory chain. `now` is the chain clock (unix seconds). */
export class FakeNotary implements ChainState {
  readonly config: ChainConfig = BASE_SEPOLIA;
  readonly records = new Map<string, Stored>();
  readonly credits = new Map<string, bigint>();
  head = 5_000n;
  /** Counts of what the submitter was asked to do. */
  readonly calls = { notarize: 0, acknowledge: 0 };
  /** Refuse every item at the submitter (it can only censor, 04 §7). */
  censor = false;
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  fund(payer: string, units: bigint): void {
    this.credits.set(payer.toLowerCase(), units);
  }

  creditOf(payer: string): bigint {
    return this.credits.get(payer.toLowerCase()) ?? 0n;
  }

  /** Writes a record as if some other path had put it on-chain (for tamper tests). */
  put(record: OccRecord): Hex {
    const recordId = computeRecordId(
      this.config.chainId,
      this.config.contracts.notary,
      record.signer,
      BigInt(record.nonce),
    );
    this.records.set(recordId, {
      record,
      structHash: encodeHex0x(recordStructHash(record)) as Hex,
      timestamp: BigInt(this.#now()),
      receiptAt: [0n, 0n, 0n, 0n],
    });
    return recordId;
  }

  // --- ChainState ----------------------------------------------------------------------------------

  getRecord(recordId: Hex): Promise<StoredRecord | null> {
    const s = this.records.get(recordId.toLowerCase());
    return Promise.resolve(
      s === undefined
        ? null
        : {
            signer: s.record.signer as Hex,
            recordStructHash: s.structHash,
            receiptAt: [...s.receiptAt],
          },
    );
  }

  block(tag: 'latest' | 'finalized' | bigint): Promise<BlockInfo> {
    const number =
      typeof tag === 'bigint' ? tag : tag === 'finalized' ? this.head - 20n : this.head;
    return Promise.resolve({ number, timestamp: BigInt(this.#now()) });
  }

  txStatus(): Promise<'pending' | 'success' | 'reverted'> {
    return Promise.resolve('success');
  }

  simulate(tx: ContractTx): Promise<TxSimulation> {
    const [items, sigs] = tx.args as [Record<string, unknown>[], string[]];
    const error =
      tx.functionName === 'notarizeBatch'
        ? this.#checkRecord(recordOf(items[0] as Record<string, unknown>), sigs[0] as string)
        : tx.functionName === 'acknowledgeBatch'
          ? this.#checkReceipt(receiptOf(items[0] as Record<string, unknown>), sigs[0] as string)
          : 'reverted';
    return Promise.resolve(error === null ? { ok: true, gas: 100_000n } : { ok: false, error });
  }

  fees() {
    return Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  }
  pendingNonce(): Promise<number> {
    return Promise.resolve(0);
  }
  nativeBalance(): Promise<bigint> {
    return Promise.resolve(0n);
  }
  allowance(): Promise<bigint> {
    return Promise.resolve(0n);
  }
  minDeposit(): Promise<bigint> {
    return Promise.resolve(1_000_000n);
  }
  creditsOf(payer: Hex): Promise<bigint> {
    return Promise.resolve(this.creditOf(payer));
  }
  tokenBalance(): Promise<bigint> {
    return Promise.resolve(0n);
  }

  // --- the contract rules --------------------------------------------------------------------------

  #recordId(record: OccRecord): string {
    return computeRecordId(
      this.config.chainId,
      this.config.contracts.notary,
      record.signer,
      BigInt(record.nonce),
    );
  }

  #checkRecord(record: OccRecord, signature: string): string | null {
    const domain = occV2Domain(this.config.chainId, this.config.contracts.notary);
    if (
      !recovers(hashTypedData(recordTypedData(domain, record)).digest, signature, record.signer)
    ) {
      return 'InvalidSignature';
    }
    if (record.deadline < this.#now()) return 'Expired';
    if (this.records.has(this.#recordId(record))) return 'RecordExists';
    if (this.creditOf(record.signer) < BigInt(record.maxFee)) return 'InsufficientCredits';
    return null;
  }

  #checkReceipt(receipt: OccReceipt, signature: string): string | null {
    const domain = occV2Domain(this.config.chainId, this.config.contracts.notary);
    const digest = hashTypedData(receiptTypedData(domain, receipt)).digest;
    if (!recovers(digest, signature, receipt.signer)) return 'InvalidSignature';
    if (receipt.deadline < this.#now()) return 'Expired';
    const s = this.records.get(receipt.recordId);
    if (s === undefined) return 'RecordNotFound';
    const opened = encodeHex0x(recipientCommitment(receipt.signer, receipt.salt));
    if (opened !== s.record.recipientCommitment) return 'InvalidCommitment';
    if ((s.receiptAt[receipt.receiptType - 1] ?? 0n) !== 0n) return 'ReceiptExists';
    const other = receipt.receiptType === 3 ? 4 : receipt.receiptType === 4 ? 3 : 0;
    if (other !== 0 && (s.receiptAt[other - 1] ?? 0n) !== 0n) return 'ReceiptExists';
    return null;
  }

  #apply(kind: 'record' | 'receipt', item: OccRecord | OccReceipt, signature: string) {
    if (kind === 'record') {
      const record = item as OccRecord;
      const error = this.#checkRecord(record, signature);
      const recordId = this.#recordId(record) as Hex;
      if (error !== null) return { id: recordId, recordId, status: 'failed' as const, error };
      this.credits.set(record.signer, this.creditOf(record.signer) - BigInt(record.maxFee));
      this.put(record);
      this.head += 1n;
      return { id: recordId, recordId, status: 'recorded' as const, txHash: txHash(this.head) };
    }
    const receipt = item as OccReceipt;
    const id = `${receipt.recordId}:${String(receipt.receiptType)}`;
    const error = this.#checkReceipt(receipt, signature);
    if (error !== null) {
      return { id, recordId: receipt.recordId as Hex, status: 'failed' as const, error };
    }
    const s = this.records.get(receipt.recordId) as Stored;
    s.receiptAt[receipt.receiptType - 1] = BigInt(this.#now());
    this.head += 1n;
    return {
      id,
      recordId: receipt.recordId as Hex,
      status: 'recorded' as const,
      txHash: txHash(this.head),
    };
  }

  // --- the submitter -------------------------------------------------------------------------------

  readonly submitter: SubmitterClient = {
    notarize: (chainId, items): Promise<SubmitResponse> => {
      this.calls.notarize += 1;
      if (this.censor) return Promise.reject(new Error('unavailable'));
      return Promise.resolve({
        chainId,
        items: items.map((i) => this.#apply('record', i.record, i.signature)),
      });
    },
    acknowledge: (chainId, items): Promise<SubmitResponse> => {
      this.calls.acknowledge += 1;
      if (this.censor) return Promise.reject(new Error('unavailable'));
      return Promise.resolve({
        chainId,
        items: items.map((i) => this.#apply('receipt', i.receipt, i.signature)),
      });
    },
    status: () => Promise.reject(new Error('not used')),
    health: () => Promise.reject(new Error('not used')),
  };

  // --- the read client -----------------------------------------------------------------------------

  readonly client: ReadClient = {
    readContract: (call: { functionName: string; args?: readonly unknown[] }) => {
      const args = call.args ?? [];
      switch (call.functionName) {
        case 'getRecord': {
          const s = this.records.get(String(args[0]).toLowerCase());
          if (s === undefined) {
            const zero32 = `0x${'0'.repeat(64)}`;
            return Promise.resolve({
              signer: `0x${'0'.repeat(40)}`,
              timestamp: 0n,
              kind: 0,
              receiptFlags: 0,
              envelopeHash: zero32,
              recipientCommitment: zero32,
              recordStructHash: zero32,
              receiptAt: [0n, 0n, 0n, 0n],
            });
          }
          let flags = 0;
          s.receiptAt.forEach((at, i) => {
            if (at !== 0n) flags |= 1 << i;
          });
          return Promise.resolve({
            signer: s.record.signer,
            timestamp: s.timestamp,
            kind: s.record.kind,
            receiptFlags: flags,
            envelopeHash: s.record.envelopeHash,
            recipientCommitment: s.record.recipientCommitment,
            recordStructHash: s.structHash,
            receiptAt: [...s.receiptAt],
          });
        }
        case 'quote':
          return Promise.resolve([FEE_UNITS, 0n, FEE_UNITS]);
        case 'creditsOf':
          return Promise.resolve(this.creditOf(String(args[0])));
        case 'balanceOf':
          return Promise.resolve(0n);
        case 'minDeposit':
          return Promise.resolve(1_000_000n);
        default:
          return Promise.reject(new Error('fake chain: unexpected read'));
      }
    },
    getCode: () => Promise.resolve(undefined),
  } as unknown as ReadClient;

  /** The proof submitter over this chain, with instant polls. */
  proofSubmitter(): ProofSubmitter {
    return createProofSubmitter({
      state: this,
      submitters: [this.submitter],
      pollMs: 1,
      waitMs: 5,
      sleep: () => Promise.resolve(),
    });
  }

  /** The core's proofs platform over this chain (07 §6.2, §6.3). */
  platform(): ProofsPlatform {
    const chain: ProofChain = {
      config: this.config,
      client: this.client,
      state: this,
      submitter: this.proofSubmitter(),
    };
    return { kit: chainKit, chains: [chain] };
  }
}

const txHash = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
