// M1-4c: submission, direct mode, inclusion tracking and deposits (07 §6.2, §6.3, §7; 04 §5, §7;
// 05 §3.2, §3.3). Every decision is taken from chain reads, never from a submitter's answer: the
// submitters here lie in the ways 04 §7 names (a wrong transaction hash, a silent drop, a modified
// record, a false failure) and the client must notice it on-chain and fail over.
//
// No network: an in-memory Notary and fee vault (`Ledger`) plays the chain behind the ChainState
// port, and direct-mode transactions are signed with a test key and "mined" by decoding them.
// Keys here are test values built at run time (a repeated byte), never a real secret.
import { encodeHex0x, recordStructHash, type OccReceipt, type OccRecord } from '@4thtech-io/crypto';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import {
  ChainError,
  FEE_VAULT_CLIENT_ABI,
  encodeFeeVaultCall,
  NOTARY_CLIENT_ABI,
  getChainConfig,
  sendDirect,
  type BlockInfo,
  type ChainState,
  type ContractTx,
  type DirectSigner,
  type StoredRecord,
  type TxSimulation,
} from '../clients/index.js';
import type { ChainConfig } from '../config/index.js';
import {
  buildDeposit,
  checkGaslessTopUp,
  planDeposit,
  sendDeposit,
  type DepositStep,
} from '../fees/index.js';
import { ChainInputError, computeRecordId, type Hex } from '../ids/index.js';
import { selectAgain, type ChainSelection } from '../select/index.js';
import { buildReceipt, buildRecord, RECORD_KIND } from '../typed-data/index.js';
import {
  SubmitterError,
  createProofSubmitter,
  readInclusion,
  replacementAllowed,
  type ProofSubmitterOptions,
  type StatusResponse,
  type SubmitResponse,
  type SubmitterClient,
} from './index.js';

const config = getChainConfig(84532) as ChainConfig;
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const CHAIN_ID = config.chainId;
const NOTARY = config.contracts.notary;
const VAULT = config.contracts.vault;
const USDC = config.feeTokens.find((t) => t.symbol === 'USDC')?.address as Hex;
if (!USDC) throw new Error('test setup: no USDC on Base Sepolia');

const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const AGENT_KEY = testKey('a1');
const OTHER_KEY = testKey('b2');
const AGENT_ACCOUNT = privateKeyToAccount(AGENT_KEY);
const OTHER_ACCOUNT = privateKeyToAccount(OTHER_KEY);
const AGENT = AGENT_ACCOUNT.address.toLowerCase() as Hex;
const RECIPIENT = OTHER_ACCOUNT.address.toLowerCase() as Hex;
const GAS_ADDRESS = `0x${'c3'.repeat(20)}` as Hex;
const hash32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const FEE = 100_000n; // $0.10 in 6-decimal USDC
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Hex;

// --- the in-memory chain -----------------------------------------------------------------------

interface Rec {
  signer: Hex;
  structHash: Hex;
  block: bigint;
  receiptAt: bigint[];
  receiptBlock: (bigint | null)[];
}

const key2 = (a: string, b: string) => `${a.toLowerCase()}|${b.toLowerCase()}`;

/** The record tuple as the client encodes it, back to its 05 §3.1 JSON form. */
function recordJson(r: Record<string, unknown>): OccRecord {
  return {
    signer: String(r.signer).toLowerCase(),
    envelopeHash: String(r.envelopeHash),
    recipientCommitment: String(r.recipientCommitment),
    parentRecordId: String(r.parentRecordId),
    appId: String(r.appId),
    kind: Number(r.kind),
    feeToken: String(r.feeToken).toLowerCase(),
    maxFee: String(r.maxFee),
    nonce: String(r.nonce),
    deadline: Number(r.deadline),
  };
}

/** A record's JSON form as a tuple (what a submitter would send). */
function recordTuple(r: OccRecord) {
  return {
    signer: r.signer,
    envelopeHash: r.envelopeHash,
    recipientCommitment: r.recipientCommitment,
    parentRecordId: r.parentRecordId,
    appId: r.appId,
    kind: r.kind,
    feeToken: r.feeToken,
    maxFee: BigInt(r.maxFee),
    nonce: BigInt(r.nonce),
    deadline: BigInt(r.deadline),
  };
}

function receiptTuple(r: OccReceipt) {
  return {
    signer: r.signer,
    recordId: r.recordId,
    receiptType: r.receiptType,
    salt: r.salt,
    deadline: BigInt(r.deadline),
  };
}

class Ledger implements ChainState {
  readonly config: ChainConfig;
  head = 1_000n;
  /** How many blocks `finalized` trails the head. */
  finalizedLag = 10n;
  readonly t0 = BigInt(Math.floor(Date.now() / 1000)) - 2_000n * 2n;
  readonly records = new Map<string, Rec>();
  readonly credits = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly tokenBalances = new Map<string, bigint>();
  readonly native = new Map<string, bigint>();
  readonly nonces = new Map<string, number>();
  readonly txs = new Map<string, 'success' | 'reverted'>();
  readonly broadcasts: Hex[] = [];
  readonly simulations: ContractTx[] = [];
  /** USDT style: approve from a nonzero allowance to another nonzero value reverts. */
  usdtStyle = false;
  /** Broadcasts are accepted but never included. */
  dropBroadcasts = false;
  /** Every read fails (an RPC outage). */
  failReads = false;

  constructor(cfg: ChainConfig = config) {
    this.config = cfg;
  }

  ts(n: bigint): bigint {
    return this.t0 + n * 2n;
  }

  now(): bigint {
    return this.ts(this.head);
  }

  private guard(): void {
    if (this.failReads) throw new ChainError('rpc_unavailable');
  }

  getRecord(recordId: Hex, blockNumber?: bigint): Promise<StoredRecord | null> {
    this.guard();
    const at = blockNumber ?? this.head;
    const r = this.records.get(recordId.toLowerCase());
    if (!r || r.block > at) return Promise.resolve(null);
    return Promise.resolve({
      signer: r.signer,
      recordStructHash: r.structHash,
      receiptAt: r.receiptAt.map((t, i) => {
        const b = r.receiptBlock[i];
        return b !== null && b !== undefined && b <= at ? t : 0n;
      }),
    });
  }

  block(tag: 'latest' | 'finalized' | bigint): Promise<BlockInfo> {
    this.guard();
    const n =
      tag === 'latest' ? this.head : tag === 'finalized' ? this.head - this.finalizedLag : tag;
    return Promise.resolve({ number: n, timestamp: this.ts(n) });
  }

  txStatus(hash: Hex): Promise<'pending' | 'success' | 'reverted'> {
    this.guard();
    return Promise.resolve(this.txs.get(hash.toLowerCase()) ?? 'pending');
  }

  simulate(tx: ContractTx): Promise<TxSimulation> {
    this.guard();
    this.simulations.push(tx);
    const out = this.exec(tx, false);
    return Promise.resolve(out.ok ? { ok: true, gas: 120_000n } : out);
  }

  fees() {
    this.guard();
    return Promise.resolve({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  }

  pendingNonce(address: Hex): Promise<number> {
    this.guard();
    return Promise.resolve(this.nonces.get(address.toLowerCase()) ?? 0);
  }

  nativeBalance(address: Hex): Promise<bigint> {
    this.guard();
    return Promise.resolve(this.native.get(address.toLowerCase()) ?? 0n);
  }

  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint> {
    this.guard();
    return Promise.resolve(this.allowances.get(`${key2(token, owner)}|${spender}`) ?? 0n);
  }

  minDeposit(): Promise<bigint> {
    this.guard();
    return Promise.resolve(5_000_000n);
  }

  tokenBalance(token: Hex, owner: Hex): Promise<bigint> {
    this.guard();
    return Promise.resolve(this.tokenBalances.get(key2(token, owner)) ?? 0n);
  }

  creditsOf(payer: Hex, token: Hex): Promise<bigint> {
    this.guard();
    return Promise.resolve(this.credits.get(key2(payer, token)) ?? 0n);
  }

  /** Runs a contract call against the ledger; `commit` applies it at the current head. */
  exec(tx: ContractTx, commit: boolean): { ok: true } | { ok: false; error: string } {
    const fail = (error: string) => ({ ok: false as const, error });
    const a = tx.args as unknown[];
    switch (tx.functionName) {
      case 'notarizeDirect': {
        // Pays now (the deployed Notary): only the signer may send it; for an ERC-20 fee token it
        // pulls exactly maxFee from the signer through its allowance to the vault, for the native
        // coin it deposits msg.value; then it charges the fee from the signer's credits.
        const rec = recordJson(a[0] as Record<string, unknown>);
        if (tx.from.toLowerCase() !== rec.signer) return fail('NotSigner');
        if (BigInt(rec.deadline) < this.now()) return fail('Expired');
        const id = computeRecordId(this.config.chainId, NOTARY, rec.signer, BigInt(rec.nonce));
        if (this.records.has(id)) return fail('RecordExists');
        const native = rec.feeToken === ZERO_ADDRESS;
        const amount = native ? tx.value : BigInt(rec.maxFee);
        const ak = `${key2(rec.feeToken, rec.signer)}|${VAULT}`;
        const bk = key2(rec.feeToken, rec.signer);
        if (!native) {
          if (tx.value !== 0n) return fail('TransferFailed');
          if ((this.allowances.get(ak) ?? 0n) < amount) return fail('reverted');
          if ((this.tokenBalances.get(bk) ?? 0n) < amount) return fail('reverted');
        }
        const ck = key2(rec.signer, rec.feeToken);
        if (BigInt(rec.maxFee) < FEE) return fail('FeeAboveMax');
        if ((this.credits.get(ck) ?? 0n) + amount < FEE) return fail('InsufficientCredits');
        if (commit) {
          if (!native) {
            this.allowances.set(ak, (this.allowances.get(ak) ?? 0n) - amount);
            this.tokenBalances.set(bk, (this.tokenBalances.get(bk) ?? 0n) - amount);
          }
          this.credits.set(ck, (this.credits.get(ck) ?? 0n) + amount - FEE);
          this.put(id, rec);
        }
        return { ok: true };
      }
      case 'notarizeBatch': {
        // Charges the record signer's existing credits, whoever sends it (05 §3.3).
        const list = a[0] as Record<string, unknown>[];
        const spend = new Map<string, bigint>();
        const writes: { id: string; rec: OccRecord }[] = [];
        for (const raw of list) {
          const rec = recordJson(raw);
          const id = computeRecordId(this.config.chainId, NOTARY, rec.signer, BigInt(rec.nonce));
          const existing = this.records.get(id);
          const mine = encodeHex0x(recordStructHash(rec)) as Hex;
          if (existing) {
            if (existing.structHash === mine) continue;
            return fail('RecordExists');
          }
          if (BigInt(rec.deadline) < this.now()) return fail('Expired');
          if (BigInt(rec.maxFee) < FEE) return fail('FeeAboveMax');
          const k = key2(rec.signer, rec.feeToken);
          const used = (spend.get(k) ?? 0n) + FEE;
          if ((this.credits.get(k) ?? 0n) < used) return fail('InsufficientCredits');
          spend.set(k, used);
          writes.push({ id, rec });
        }
        if (commit) {
          for (const [k, v] of spend) this.credits.set(k, (this.credits.get(k) ?? 0n) - v);
          for (const { id, rec } of writes) this.put(id, rec);
        }
        return { ok: true };
      }
      case 'acknowledgeBatch':
      case 'acknowledge': {
        const list =
          tx.functionName === 'acknowledgeBatch'
            ? (a[0] as Record<string, unknown>[])
            : [a[0] as Record<string, unknown>];
        const sets: { r: Rec; t: number }[] = [];
        for (const raw of list) {
          const r = this.records.get(String(raw.recordId).toLowerCase());
          if (!r) return fail('RecordNotFound');
          if (BigInt(raw.deadline as bigint) < this.now()) return fail('Expired');
          const t = Number(raw.receiptType);
          const conflict = t === 3 ? 4 : t === 4 ? 3 : 0;
          if (conflict !== 0 && (r.receiptAt[conflict - 1] ?? 0n) !== 0n) {
            return fail('ConflictingReceipt');
          }
          if ((r.receiptAt[t - 1] ?? 0n) !== 0n) {
            if (tx.functionName === 'acknowledgeBatch') continue;
            return fail('ReceiptExists');
          }
          sets.push({ r, t });
        }
        if (commit) {
          for (const { r, t } of sets) {
            r.receiptAt[t - 1] = this.now();
            r.receiptBlock[t - 1] = this.head;
          }
        }
        return { ok: true };
      }
      case 'approve': {
        const [spender, amount] = a as [Hex, bigint];
        const k = `${key2(tx.to, tx.from)}|${spender.toLowerCase()}`;
        const current = this.allowances.get(k) ?? 0n;
        if (this.usdtStyle && current !== 0n && amount !== 0n) return fail('reverted');
        if (commit) this.allowances.set(k, amount);
        return { ok: true };
      }
      case 'deposit': {
        const [token, amount] = a as [Hex, bigint];
        const ak = `${key2(token, tx.from)}|${VAULT}`;
        const bk = key2(token, tx.from);
        if ((this.allowances.get(ak) ?? 0n) < amount) return fail('reverted');
        if ((this.tokenBalances.get(bk) ?? 0n) < amount) return fail('reverted');
        if (commit) {
          this.allowances.set(ak, (this.allowances.get(ak) ?? 0n) - amount);
          this.tokenBalances.set(bk, (this.tokenBalances.get(bk) ?? 0n) - amount);
          const ck = key2(tx.from, token);
          this.credits.set(ck, (this.credits.get(ck) ?? 0n) + amount);
        }
        return { ok: true };
      }
      default:
        return fail('reverted');
    }
  }

  put(id: string, rec: OccRecord): void {
    this.records.set(id, {
      signer: rec.signer as Hex,
      structHash: encodeHex0x(recordStructHash(rec)) as Hex,
      block: this.head,
      receiptAt: [0n, 0n, 0n, 0n],
      receiptBlock: [null, null, null, null],
    });
  }

  /** Mines one transaction (a submitter's or a direct one). Returns its status. */
  mine(tx: ContractTx, hash: Hex): 'success' | 'reverted' {
    this.head += 1n;
    const status = this.exec(tx, true).ok ? 'success' : 'reverted';
    this.txs.set(hash.toLowerCase(), status);
    return status;
  }

  /** The direct-mode broadcast: decode the signed bytes, then mine them (or drop them). */
  broadcast = async (raw: Hex): Promise<void> => {
    this.broadcasts.push(raw);
    const tx = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({ serializedTransaction: raw as never })
    ).toLowerCase();
    this.nonces.set(from, (this.nonces.get(from) ?? 0) + 1);
    if (this.dropBroadcasts) return;
    const to = (tx.to ?? '').toLowerCase() as Hex;
    const abi = to === NOTARY ? NOTARY_CLIENT_ABI : to === VAULT ? FEE_VAULT_CLIENT_ABI : erc20Abi;
    const { functionName, args } = decodeFunctionData({ abi, data: tx.data as Hex });
    const contract = to === NOTARY ? 'notary' : to === VAULT ? 'vault' : 'erc20';
    this.mine(
      {
        contract,
        to,
        from: from as Hex,
        value: tx.value ?? 0n,
        functionName,
        args: [...(args ?? [])],
      },
      keccak256(raw) as Hex,
    );
  };
}

// --- fake submitters ---------------------------------------------------------------------------

type Behaviour =
  | 'honest'
  | 'wrong_hash'
  | 'silent_drop'
  | 'modified'
  | 'failed_but_included'
  | 'false_credits'
  | 'down'
  | 'refuses';

interface FakeSubmitter extends SubmitterClient {
  readonly sent: { record?: OccRecord; receipt?: OccReceipt; signature: string }[];
}

let txCounter = 0;
const nextTx = (): Hex => {
  txCounter += 1;
  return `0x${txCounter.toString(16).padStart(64, '0')}` as Hex;
};

function fakeSubmitter(ledger: Ledger, behaviour: Behaviour): FakeSubmitter {
  const sent: FakeSubmitter['sent'] = [];
  const answer = (items: SubmitResponse['items']): SubmitResponse => ({ chainId: CHAIN_ID, items });
  const mineRecords = (records: OccRecord[]) => {
    const hash = nextTx();
    ledger.mine(
      {
        contract: 'notary',
        to: NOTARY,
        from: GAS_ADDRESS,
        value: 0n,
        functionName: 'notarizeBatch',
        args: [records.map(recordTuple), records.map(() => '0x')],
      },
      hash,
    );
    return hash;
  };
  const mineReceipts = (receipts: OccReceipt[]) => {
    const hash = nextTx();
    ledger.mine(
      {
        contract: 'notary',
        to: NOTARY,
        from: GAS_ADDRESS,
        value: 0n,
        functionName: 'acknowledgeBatch',
        args: [receipts.map(receiptTuple), receipts.map(() => '0x')],
      },
      hash,
    );
    return hash;
  };
  return {
    sent,
    notarize(chainId, items) {
      for (const i of items) sent.push({ record: i.record, signature: i.signature });
      if (behaviour === 'down') return Promise.reject(new SubmitterError('unavailable'));
      if (behaviour === 'refuses') return Promise.reject(new SubmitterError('refused', 'bad'));
      expect(chainId).toBe(CHAIN_ID);
      const ids = items.map((i) =>
        computeRecordId(CHAIN_ID, NOTARY, i.record.signer, BigInt(i.record.nonce)),
      );
      switch (behaviour) {
        case 'honest': {
          const tx = mineRecords(items.map((i) => i.record));
          return Promise.resolve(
            answer(ids.map((id) => ({ id, recordId: id, status: 'recorded', txHash: tx }))),
          );
        }
        case 'wrong_hash':
        case 'silent_drop':
          return Promise.resolve(
            answer(
              ids.map((id) => ({
                id,
                recordId: id,
                status: 'submitted',
                txHash: behaviour === 'wrong_hash' ? hash32('ee') : nextTx(),
              })),
            ),
          );
        case 'modified':
          // It claims success for a record that is not the one it was given.
          return Promise.resolve(
            answer([{ id: hash32('99'), recordId: hash32('99'), status: 'recorded' }]),
          );
        case 'failed_but_included': {
          const tx = mineRecords(items.map((i) => i.record));
          return Promise.resolve(
            answer(
              ids.map((id) => ({
                id,
                recordId: id,
                status: 'failed',
                txHash: tx,
                error: 'reverted',
              })),
            ),
          );
        }
        case 'false_credits':
          return Promise.resolve(
            answer(
              ids.map((id) => ({
                id,
                recordId: id,
                status: 'failed',
                error: 'InsufficientCredits',
              })),
            ),
          );
      }
    },
    acknowledge(chainId, items) {
      for (const i of items) sent.push({ receipt: i.receipt, signature: i.signature });
      if (behaviour === 'down') return Promise.reject(new SubmitterError('unavailable'));
      expect(chainId).toBe(CHAIN_ID);
      const ids = items.map((i) => `${i.receipt.recordId}:${String(i.receipt.receiptType)}`);
      if (behaviour === 'honest' || behaviour === 'failed_but_included') {
        const tx = mineReceipts(items.map((i) => i.receipt));
        return Promise.resolve(
          answer(
            items.map((i, n) => ({
              id: ids[n] as string,
              recordId: i.receipt.recordId as Hex,
              status: behaviour === 'honest' ? 'recorded' : 'failed',
              txHash: tx,
            })),
          ),
        );
      }
      return Promise.resolve(
        answer(
          items.map((i, n) => ({
            id: ids[n] as string,
            recordId: i.receipt.recordId as Hex,
            status: 'submitted',
            txHash: hash32('ee'),
          })),
        ),
      );
    },
    status(): Promise<StatusResponse> {
      return Promise.reject(new SubmitterError('unavailable'));
    },
    health() {
      return Promise.reject(new SubmitterError('unavailable'));
    },
  };
}

// --- signed items ------------------------------------------------------------------------------

async function signDigest(digest: Hex, key: ViemHex): Promise<Hex> {
  return (await sign({ hash: digest, privateKey: key, to: 'hex' })) as Hex;
}

async function signedRecord(
  ledger: Ledger,
  deadline?: number,
  fee: { token: Hex; maxFee: bigint } = { token: USDC, maxFee: 500_000n },
) {
  const built = buildRecord({
    chainId: ledger.config.chainId,
    notary: NOTARY,
    signer: AGENT,
    envelopeHash: hash32('11'),
    recipient: RECIPIENT,
    kind: RECORD_KIND.MESSAGE,
    feeToken: fee.token,
    maxFee: fee.maxFee,
    deadline: deadline ?? Number(ledger.now()) + 3_600,
  });
  return {
    built,
    item: { record: built.record, signature: await signDigest(built.digest, AGENT_KEY) },
  };
}

async function signedReceipt(ledger: Ledger, recordId: Hex, receiptType = 1, deadline?: number) {
  const built = buildReceipt({
    chainId: CHAIN_ID,
    notary: NOTARY,
    signer: RECIPIENT,
    recordId,
    receiptType,
    salt: hash32('22'),
    deadline: deadline ?? Number(ledger.now()) + 3_600,
  });
  return { receipt: built.receipt, signature: await signDigest(built.digest, OTHER_KEY) };
}

/** A direct-mode signer over a test key (the KeyStore's transaction signer in production). */
function directSigner(account = AGENT_ACCOUNT): DirectSigner & { signed: number } {
  const s = {
    signed: 0,
    address: account.address.toLowerCase() as Hex,
    async signTransaction(tx: Parameters<DirectSigner['signTransaction']>[0]) {
      s.signed += 1;
      return (await account.signTransaction(tx)) as Hex;
    },
  };
  return s;
}

/** A Chiado-like config: the same contracts, native xDAI as the only fee token. */
function gnosisConfig(): ChainConfig {
  const source = (config.feeTokens[0] as ChainConfig['feeTokens'][number]).source;
  return {
    ...config,
    key: 'gnosis-chiado',
    chainId: 10200,
    feeTokens: [{ symbol: 'NATIVE', address: null, decimals: 18, source }],
  };
}

function funded(ledger: Ledger, credits = 1_000_000n): Ledger {
  ledger.credits.set(key2(AGENT, USDC), credits);
  return ledger;
}

const noSleep = () => Promise.resolve();

function submitterFor(
  ledger: Ledger,
  submitters: SubmitterClient[],
  extra: Partial<ProofSubmitterOptions> = {},
) {
  return createProofSubmitter({
    state: ledger,
    submitters,
    pollMs: 1,
    waitMs: 5,
    sleep: noSleep,
    ...extra,
  });
}

// --- notarize through submitters ---------------------------------------------------------------

describe('notarize: results come from chain reads, never from a submitter alone', () => {
  it('an honest submitter: recorded, confirmed only once the configured depth is reached', async () => {
    const ledger = funded(new Ledger());
    const sub = fakeSubmitter(ledger, 'honest');
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [sub]).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', recordId: built.recordId, via: 'submitter' });
    expect(sub.sent).toHaveLength(1);
    expect(sub.sent[0]).toEqual({ record: built.record, signature: item.signature });
    expect(await readInclusion(ledger, { recordId: built.recordId, record: built.record })).toBe(
      'included',
    );
    ledger.head += BigInt(config.confirmations);
    expect(await readInclusion(ledger, { recordId: built.recordId, record: built.record })).toBe(
      'confirmed',
    );
  });

  it.each(['wrong_hash', 'silent_drop', 'modified', 'down', 'refuses'] as const)(
    'a %s submitter is detected on-chain and the next submitter gets the same signed record',
    async (behaviour) => {
      const ledger = funded(new Ledger());
      const bad = fakeSubmitter(ledger, behaviour);
      const good = fakeSubmitter(ledger, 'honest');
      const { built, item } = await signedRecord(ledger);
      const out = await submitterFor(ledger, [bad, good]).notarize(item);
      expect(out).toMatchObject({ status: 'recorded', recordId: built.recordId, via: 'submitter' });
      expect(bad.sent).toHaveLength(1);
      expect(good.sent).toHaveLength(1);
      // Idempotent retry: byte-for-byte the same signed record, never a new one.
      expect(good.sent[0]).toEqual(bad.sent[0]);
    },
  );

  it('a submitter that reports `failed` for a record it included: success, no failover, no replacement', async () => {
    const ledger = funded(new Ledger());
    const liar = fakeSubmitter(ledger, 'failed_but_included');
    const next = fakeSubmitter(ledger, 'honest');
    const { built, item } = await signedRecord(ledger, Number(ledger.now()) + 60);
    const out = await submitterFor(ledger, [liar, next]).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', recordId: built.recordId });
    expect(next.sent).toHaveLength(0);
    // Even past the deadline and finality, the record stands: no replacement may be signed.
    ledger.head += 1_000n;
    expect(
      await replacementAllowed(ledger, {
        recordId: built.recordId,
        deadline: built.record.deadline,
      }),
    ).toBe(false);
  });

  it('a false InsufficientCredits answer is checked by simulation and failed over', async () => {
    const ledger = funded(new Ledger());
    const liar = fakeSubmitter(ledger, 'false_credits');
    const next = fakeSubmitter(ledger, 'honest');
    const selector = { clear: vi.fn() };
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [liar, next], { selector }).notarize(item);
    expect(out.status).toBe('recorded');
    expect(next.sent).toHaveLength(1);
  });

  it('every submitter lies and there is no direct mode: pending, nothing signed, same item kept', async () => {
    const ledger = funded(new Ledger());
    const subs = [fakeSubmitter(ledger, 'silent_drop'), fakeSubmitter(ledger, 'wrong_hash')];
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, subs).notarize(item);
    expect(out).toEqual({ status: 'pending', id: built.recordId, recordId: built.recordId });
  });

  it('a record already on-chain in identical form is success without contacting anyone', async () => {
    const ledger = funded(new Ledger());
    const sub = fakeSubmitter(ledger, 'honest');
    const { built, item } = await signedRecord(ledger);
    ledger.put(built.recordId, built.record);
    const out = await submitterFor(ledger, [sub]).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', via: 'chain', recordId: built.recordId });
    expect(sub.sent).toHaveLength(0);
  });

  it('a record ID that holds a different record is a conflict, never success', async () => {
    const ledger = funded(new Ledger());
    const sub = fakeSubmitter(ledger, 'honest');
    const { built, item } = await signedRecord(ledger);
    ledger.put(built.recordId, { ...built.record, envelopeHash: hash32('77') });
    const out = await submitterFor(ledger, [sub]).notarize(item);
    expect(out).toEqual({ status: 'conflict', id: built.recordId, recordId: built.recordId });
    expect(sub.sent).toHaveLength(0);
  });

  it('a record the contract refuses (Expired) fails before any submitter is asked', async () => {
    const ledger = funded(new Ledger());
    const sub = fakeSubmitter(ledger, 'honest');
    const { built, item } = await signedRecord(ledger, Number(ledger.now()) - 10);
    const out = await submitterFor(ledger, [sub]).notarize(item);
    expect(out).toEqual({
      status: 'failed',
      id: built.recordId,
      recordId: built.recordId,
      error: 'Expired',
    });
    expect(sub.sent).toHaveLength(0);
  });

  it('refuses a malformed item before any request', async () => {
    const ledger = funded(new Ledger());
    const sub = fakeSubmitter(ledger, 'honest');
    const { item } = await signedRecord(ledger);
    await expect(
      submitterFor(ledger, [sub]).notarize({ ...item, signature: 'nope' }),
    ).rejects.toBeInstanceOf(ChainInputError);
    await expect(
      submitterFor(ledger, [sub]).notarize({
        record: { ...item.record, signer: 'x' },
        signature: item.signature,
      }),
    ).rejects.toBeInstanceOf(ChainInputError);
    expect(sub.sent).toHaveLength(0);
  });
});

// --- credits and re-selection (IR-M1-26-1) -----------------------------------------------------

describe('notarize: missing credits clear the selection cache and select again once', () => {
  it('InsufficientCredits in our own simulation: needs_credits, clear(), one re-selection', async () => {
    const ledger = new Ledger(); // no credits
    const sub = fakeSubmitter(ledger, 'honest');
    const selector = { clear: vi.fn() };
    const fresh: ChainSelection = { status: 'unavailable', unavailable: [] };
    const reselect = vi.fn(() => Promise.resolve(fresh));
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [sub], { selector, reselect }).notarize(item);
    expect(out).toEqual({
      status: 'needs_credits',
      id: built.recordId,
      recordId: built.recordId,
      selection: fresh,
    });
    expect(selector.clear).toHaveBeenCalledTimes(1);
    expect(reselect).toHaveBeenCalledTimes(1);
    expect(selector.clear.mock.invocationCallOrder[0]).toBeLessThan(
      reselect.mock.invocationCallOrder[0] as number,
    );
    expect(sub.sent).toHaveLength(0);
  });

  it('credits spent between our simulation and the submitter: the confirmed refusal still clears', async () => {
    const ledger = funded(new Ledger());
    const selector = { clear: vi.fn() };
    // The submitter's answer is checked by a fresh simulation, which now fails for credits.
    const drains: SubmitterClient = {
      ...fakeSubmitter(ledger, 'false_credits'),
      notarize(chainId, items) {
        ledger.credits.set(key2(AGENT, USDC), 0n);
        return fakeSubmitter(ledger, 'false_credits').notarize(chainId, items);
      },
    };
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [drains], { selector }).notarize(item);
    expect(out.status).toBe('needs_credits');
    expect(selector.clear).toHaveBeenCalledTimes(1);
  });

  it('a reverted simulation (Expired) clears the cache and selects again once', async () => {
    const ledger = funded(new Ledger());
    const selector = { clear: vi.fn() };
    const fresh: ChainSelection = { status: 'unavailable', unavailable: [] };
    const reselect = vi.fn(() => Promise.resolve(fresh));
    const { built, item } = await signedRecord(ledger, Number(ledger.now()) - 10);
    const out = await submitterFor(ledger, [], { selector, reselect }).notarize(item);
    expect(out).toEqual({
      status: 'failed',
      id: built.recordId,
      recordId: built.recordId,
      error: 'Expired',
      selection: fresh,
    });
    expect(selector.clear).toHaveBeenCalledTimes(1);
    expect(reselect).toHaveBeenCalledTimes(1);
  });

  it('clears the selection cache after every paid action', async () => {
    const ledger = funded(new Ledger());
    const selector = { clear: vi.fn() };
    const { item } = await signedRecord(ledger);
    await submitterFor(ledger, [fakeSubmitter(ledger, 'honest')], { selector }).notarize(item);
    expect(selector.clear).toHaveBeenCalledTimes(1);
  });

  it('selectAgain clears the cache, then selects exactly once', async () => {
    const order: string[] = [];
    const sel: ChainSelection = { status: 'unavailable', unavailable: [] };
    const selector = {
      clear: vi.fn(() => order.push('clear')),
      select: vi.fn(() => {
        order.push('select');
        return Promise.resolve(sel);
      }),
    };
    const got = await selectAgain(selector, [], AGENT, { feeType: 'NOTARIZE' });
    expect(got).toBe(sel);
    expect(order).toEqual(['clear', 'select']);
  });
});

// --- direct mode -------------------------------------------------------------------------------

describe('direct mode: the agent pays gas itself, simulated before sending', () => {
  /** The decoded calls the agent broadcast, in order. */
  function sentCalls(ledger: Ledger) {
    return ledger.broadcasts.map((raw) => {
      const tx = parseTransaction(raw);
      const to = (tx.to ?? '').toLowerCase();
      const abi =
        to === NOTARY ? NOTARY_CLIENT_ABI : to === VAULT ? FEE_VAULT_CLIENT_ABI : erc20Abi;
      const { functionName, args } = decodeFunctionData({ abi, data: tx.data as Hex });
      return { to, functionName, args: [...(args ?? [])] as unknown[], value: tx.value ?? 0n };
    });
  }

  it('every submitter fails, credits cover the fee: notarizeBatch from the agent, confirmed on-chain', async () => {
    const ledger = funded(new Ledger());
    ledger.native.set(AGENT, 10n ** 17n);
    const signer = directSigner();
    const selector = { clear: vi.fn() };
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [fakeSubmitter(ledger, 'silent_drop')], {
      direct: { signer, broadcast: ledger.broadcast },
      selector,
    }).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', via: 'direct', recordId: built.recordId });
    expect(signer.signed).toBe(1);
    expect(sentCalls(ledger).map((c) => c.functionName)).toEqual(['notarizeBatch']);
    expect(sentCalls(ledger)[0]?.value).toBe(0n);
    // Simulated from the agent's own account before it was sent.
    expect(
      ledger.simulations.some((s) => s.functionName === 'notarizeBatch' && s.from === AGENT),
    ).toBe(true);
    expect(await ledger.creditsOf(AGENT, USDC)).toBe(1_000_000n - FEE);
    expect(selector.clear).toHaveBeenCalled();
  });

  it('USDC without credits: approve exactly maxFee, then notarizeDirect pays now', async () => {
    const ledger = new Ledger();
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.tokenBalances.set(key2(USDC, AGENT), 10_000_000n);
    const selector = { clear: vi.fn() };
    const subs = [fakeSubmitter(ledger, 'honest')];
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, subs, {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
      selector,
    }).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', via: 'direct', recordId: built.recordId });
    const calls = sentCalls(ledger);
    expect(calls.map((c) => c.functionName)).toEqual(['approve', 'notarizeDirect']);
    expect(calls[0]?.to).toBe(USDC);
    expect(calls[0]?.args).toEqual([getAddress(VAULT), 500_000n]);
    expect(calls[1]?.value).toBe(0n);
    // The leftover of maxFee stays as the agent's credits; no allowance is left behind.
    expect(await ledger.creditsOf(AGENT, USDC)).toBe(500_000n - FEE);
    expect(await ledger.allowance(USDC, AGENT, VAULT)).toBe(0n);
    // Submitters cannot charge credits that do not exist: none was asked.
    expect(subs[0]?.sent).toHaveLength(0);
    expect(selector.clear).toHaveBeenCalled();
  });

  it('USDC without credits and a leftover allowance (USDT style): reset to 0, approve, notarizeDirect', async () => {
    const ledger = new Ledger();
    ledger.usdtStyle = true;
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.tokenBalances.set(key2(USDC, AGENT), 10_000_000n);
    ledger.allowances.set(`${key2(USDC, AGENT)}|${VAULT}`, 3n);
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out.status).toBe('recorded');
    const calls = sentCalls(ledger);
    expect(calls.map((c) => c.functionName)).toEqual(['approve', 'approve', 'notarizeDirect']);
    expect(calls.map((c) => c.args[1] ?? null).slice(0, 2)).toEqual([0n, 500_000n]);
  });

  it('USDC without credits and without enough tokens: needs_credits, nothing sent', async () => {
    const ledger = new Ledger();
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.tokenBalances.set(key2(USDC, AGENT), 499_999n);
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out.status).toBe('needs_credits');
    expect(ledger.broadcasts).toHaveLength(0);
  });

  it('native fee token without credits: notarizeDirect carries maxFee as its value', async () => {
    const gnosis = gnosisConfig();
    const ledger = new Ledger(gnosis);
    ledger.native.set(AGENT, 10n ** 18n);
    const maxFee = 2n * 10n ** 16n;
    const { built, item } = await signedRecord(ledger, undefined, { token: ZERO_ADDRESS, maxFee });
    const out = await submitterFor(ledger, [], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', via: 'direct', recordId: built.recordId });
    const calls = sentCalls(ledger);
    expect(calls.map((c) => c.functionName)).toEqual(['notarizeDirect']);
    expect(calls[0]?.value).toBe(maxFee);
    expect(await ledger.creditsOf(AGENT, ZERO_ADDRESS)).toBe(maxFee - FEE);
  });

  it('no submitters at all: direct mode alone works', async () => {
    const ledger = funded(new Ledger());
    ledger.native.set(AGENT, 10n ** 17n);
    const { built, item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out).toMatchObject({ status: 'recorded', via: 'direct', recordId: built.recordId });
  });

  it('without native gas, nothing is signed or sent: pending', async () => {
    const ledger = funded(new Ledger());
    const signer = directSigner();
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer, broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out.status).toBe('pending');
    expect(signer.signed).toBe(0);
    expect(ledger.broadcasts).toHaveLength(0);
  });

  it('a direct signer that is not the record signer is never used for notarizeDirect', async () => {
    const ledger = funded(new Ledger());
    ledger.native.set(RECIPIENT, 10n ** 17n);
    const signer = directSigner(OTHER_ACCOUNT);
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer, broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out.status).toBe('pending');
    expect(signer.signed).toBe(0);
  });

  it('a direct transaction that is never included: pending; the same signed record stays valid', async () => {
    const ledger = funded(new Ledger());
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.dropBroadcasts = true;
    const { item } = await signedRecord(ledger);
    const out = await submitterFor(ledger, [], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
    }).notarize(item);
    expect(out.status).toBe('pending');
  });

  it('sendDirect refuses a signer that returns bytes for another transaction; nothing is broadcast', async () => {
    const ledger = funded(new Ledger());
    ledger.native.set(AGENT, 10n ** 17n);
    const { item } = await signedRecord(ledger);
    const tampering: DirectSigner = {
      address: AGENT,
      signTransaction: (tx) => AGENT_ACCOUNT.signTransaction({ ...tx, to: VAULT }) as Promise<Hex>,
    };
    await expect(
      sendDirect(
        ledger,
        { signer: tampering, broadcast: ledger.broadcast },
        {
          contract: 'notary',
          to: NOTARY,
          value: 0n,
          functionName: 'notarizeBatch',
          args: [[recordTuple(item.record)], [item.signature]],
        },
      ),
    ).rejects.toMatchObject({ code: 'signer_mismatch' });
    expect(ledger.broadcasts).toHaveLength(0);
  });

  it('sendDirect returns the contract refusal from simulation and signs nothing', async () => {
    const ledger = new Ledger();
    ledger.native.set(AGENT, 10n ** 17n);
    const signer = directSigner();
    const { item } = await signedRecord(ledger);
    const out = await sendDirect(
      ledger,
      { signer, broadcast: ledger.broadcast },
      {
        contract: 'notary',
        to: NOTARY,
        value: 0n,
        functionName: 'notarizeBatch',
        args: [[recordTuple(item.record)], [item.signature]],
      },
    );
    expect(out).toEqual({ ok: false, error: 'InsufficientCredits' });
    expect(signer.signed).toBe(0);
  });
});

// --- receipts ----------------------------------------------------------------------------------

describe('acknowledge: receipts confirmed by chain reads, both ways', () => {
  async function onChainRecord(ledger: Ledger) {
    const { built } = await signedRecord(ledger);
    ledger.put(built.recordId, built.record);
    return built.recordId;
  }

  it('through a submitter', async () => {
    const ledger = new Ledger();
    const recordId = await onChainRecord(ledger);
    const rc = await signedReceipt(ledger, recordId);
    const out = await submitterFor(ledger, [fakeSubmitter(ledger, 'honest')]).acknowledge(rc);
    expect(out).toMatchObject({ status: 'recorded', via: 'submitter', id: `${recordId}:1` });
  });

  it('a lying submitter fails over to direct acknowledge only when receipts may pay direct (D-114)', async () => {
    const ledger = new Ledger();
    const recordId = await onChainRecord(ledger);
    ledger.native.set(AGENT, 10n ** 17n);
    const rc = await signedReceipt(ledger, recordId);
    const out = await submitterFor(ledger, [fakeSubmitter(ledger, 'silent_drop')], {
      direct: { signer: directSigner(), broadcast: ledger.broadcast },
      directReceipts: true,
    }).acknowledge(rc);
    expect(out).toMatchObject({ status: 'recorded', via: 'direct' });
    expect(ledger.simulations.map((s) => s.functionName)).toContain('acknowledge');
  });

  it.each(['down', 'silent_drop'] as const)(
    'a %s submitter leaves the receipt pending: direct mode never pays for it unasked (D-114)',
    async (behaviour) => {
      const ledger = new Ledger();
      const recordId = await onChainRecord(ledger);
      // The recipient's account could pay the network cost, and direct mode is configured.
      ledger.native.set(AGENT, 10n ** 17n);
      const signer = directSigner();
      const rc = await signedReceipt(ledger, recordId);
      const out = await submitterFor(ledger, [fakeSubmitter(ledger, behaviour)], {
        direct: { signer, broadcast: ledger.broadcast },
      }).acknowledge(rc);
      expect(out).toMatchObject({ status: 'pending', id: `${recordId}:1` });
      // Nothing was signed or sent from the recipient's own account.
      expect(signer.signed).toBe(0);
      expect(ledger.simulations.map((s) => s.functionName)).not.toContain('acknowledge');
      expect(ledger.native.get(AGENT)).toBe(10n ** 17n);
    },
  );

  it('a receipt held back by an unreachable submitter lands unchanged on a later post (D-114)', async () => {
    const ledger = new Ledger();
    const recordId = await onChainRecord(ledger);
    const rc = await signedReceipt(ledger, recordId);
    const down = fakeSubmitter(ledger, 'down');
    expect((await submitterFor(ledger, [down]).acknowledge(rc)).status).toBe('pending');
    const up = fakeSubmitter(ledger, 'honest');
    const later = await submitterFor(ledger, [up]).acknowledge(rc);
    expect(later).toMatchObject({ status: 'recorded', via: 'submitter' });
    expect(up.sent[0]).toEqual({ receipt: rc.receipt, signature: rc.signature });
  });

  it('a receipt from a recipient with no credits on the network goes through the submitter (D-114)', async () => {
    const ledger = new Ledger();
    const recordId = await onChainRecord(ledger);
    expect(ledger.credits.size).toBe(0);
    const rc = await signedReceipt(ledger, recordId);
    const out = await submitterFor(ledger, [fakeSubmitter(ledger, 'honest')]).acknowledge(rc);
    expect(out).toMatchObject({ status: 'recorded', via: 'submitter' });
    expect(ledger.credits.size).toBe(0);
  });

  it('a receipt type already set is success; the conflicting type is a conflict', async () => {
    const ledger = new Ledger();
    const recordId = await onChainRecord(ledger);
    const rec = ledger.records.get(recordId) as Rec;
    rec.receiptAt[2] = ledger.now(); // ACCEPTED
    rec.receiptBlock[2] = ledger.head;
    const sub = fakeSubmitter(ledger, 'honest');
    const same = await submitterFor(ledger, [sub]).acknowledge(
      await signedReceipt(ledger, recordId, 3),
    );
    expect(same).toMatchObject({ status: 'recorded', via: 'chain' });
    const other = await submitterFor(ledger, [sub]).acknowledge(
      await signedReceipt(ledger, recordId, 4),
    );
    expect(other.status).toBe('conflict');
    expect(sub.sent).toHaveLength(0);
  });
});

// --- replacement (04 §5) -----------------------------------------------------------------------

describe('replacementAllowed: only when the earlier item can never land (04 §5)', () => {
  it('deadline passed, finalized block after it, no record there: allowed', async () => {
    const ledger = new Ledger();
    const deadline = Number(ledger.now()) + 10;
    ledger.head += 100n;
    expect(await replacementAllowed(ledger, { recordId: hash32('aa'), deadline })).toBe(true);
  });

  it('the finalized block is not yet after the deadline: refused', async () => {
    const ledger = new Ledger();
    const deadline = Number(ledger.now()) - 5; // passed at the head, not at `finalized`
    expect(await replacementAllowed(ledger, { recordId: hash32('aa'), deadline })).toBe(false);
  });

  it('the record exists at the finalized block: refused', async () => {
    const ledger = new Ledger();
    const { built } = await signedRecord(ledger, Number(ledger.now()) + 10);
    ledger.put(built.recordId, built.record);
    ledger.head += 100n;
    expect(
      await replacementAllowed(ledger, {
        recordId: built.recordId,
        deadline: built.record.deadline,
      }),
    ).toBe(false);
  });

  it('a failed read: refused (fail closed)', async () => {
    const ledger = new Ledger();
    const deadline = Number(ledger.now()) + 10;
    ledger.head += 100n;
    ledger.failReads = true;
    expect(await replacementAllowed(ledger, { recordId: hash32('aa'), deadline })).toBe(false);
  });

  it('a chain without the finalized tag reads at the configured depth instead', async () => {
    const ledger = new Ledger({ ...config, finalizedTag: false, confirmations: 3 });
    const blocks = vi.spyOn(ledger, 'block');
    const deadline = Number(ledger.now()) + 10;
    ledger.head += 100n;
    expect(await replacementAllowed(ledger, { recordId: hash32('aa'), deadline })).toBe(true);
    expect(blocks.mock.calls.map((c) => c[0])).not.toContain('finalized');
    expect(blocks.mock.calls.map((c) => c[0])).toContain(ledger.head - 3n);
  });

  it('a receipt: refused when its type or the conflicting type is set at finality', async () => {
    const ledger = new Ledger();
    const { built } = await signedRecord(ledger);
    ledger.put(built.recordId, built.record);
    const rec = ledger.records.get(built.recordId) as Rec;
    const deadline = Number(ledger.now()) + 10;
    rec.receiptAt[3] = ledger.now(); // REJECTED
    rec.receiptBlock[3] = ledger.head;
    ledger.head += 100n;
    const base = { recordId: built.recordId, deadline };
    expect(await replacementAllowed(ledger, { ...base, receiptType: 3 })).toBe(false);
    expect(await replacementAllowed(ledger, { ...base, receiptType: 4 })).toBe(false);
    expect(await replacementAllowed(ledger, { ...base, receiptType: 1 })).toBe(true);
  });
});

// --- deposits (IR-M1-4b-1 L-3; 12 §4.1) --------------------------------------------------------

describe('deposits: allowance read first, USDT re-approve, minDeposit, re-select after paying', () => {
  const steps = (s: { purpose: string }[]) => s.map((x) => x.purpose);

  it('buildDeposit: no allowance → approve, deposit; exact allowance → deposit only', () => {
    expect(
      steps(buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 0n })),
    ).toEqual(['approve', 'deposit']);
    expect(
      steps(buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 5n })),
    ).toEqual(['deposit']);
  });

  it('buildDeposit: a different nonzero allowance is reset to 0 first (USDT style)', () => {
    const s = buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 9n });
    expect(steps(s)).toEqual(['reset_approval', 'approve', 'deposit']);
    const args = s.map((x) =>
      x.purpose === 'deposit'
        ? null
        : decodeFunctionData({ abi: erc20Abi, data: x.data }).args?.[1],
    );
    expect(args).toEqual([0n, 5n, null]);
  });

  it('planDeposit reads the current allowance on-chain', async () => {
    const ledger = new Ledger();
    ledger.allowances.set(`${key2(USDC, AGENT)}|${VAULT}`, 7n);
    const s = await planDeposit(ledger, { payer: AGENT, token: 'USDC', amount: 5n });
    expect(steps(s)).toEqual(['reset_approval', 'approve', 'deposit']);
  });

  it('sendDeposit with a USDT-style token and a leftover allowance: succeeds, then clears and selects again', async () => {
    const ledger = new Ledger();
    ledger.usdtStyle = true;
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.tokenBalances.set(key2(USDC, AGENT), 10_000_000n);
    ledger.allowances.set(`${key2(USDC, AGENT)}|${VAULT}`, 3n);
    const plan = await planDeposit(ledger, { payer: AGENT, token: 'USDC', amount: 2_000_000n });
    const selector = { clear: vi.fn() };
    const sel: ChainSelection = { status: 'unavailable', unavailable: [] };
    const reselect = vi.fn(() => Promise.resolve(sel));
    const out = await sendDeposit(
      ledger,
      { signer: directSigner(), broadcast: ledger.broadcast },
      { token: 'USDC', amount: 2_000_000n },
      plan,
      { selector, reselect, pollMs: 1, waitMs: 5, sleep: noSleep },
    );
    expect(out.txHashes).toHaveLength(3);
    expect(out.selection).toBe(sel);
    expect(await ledger.creditsOf(AGENT, USDC)).toBe(2_000_000n);
    expect(selector.clear).toHaveBeenCalledTimes(1);
    expect(reselect).toHaveBeenCalledTimes(1);
  });

  it('without the reset, a USDT-style token refuses: no credits, no re-selection', async () => {
    const ledger = new Ledger();
    ledger.usdtStyle = true;
    ledger.native.set(AGENT, 10n ** 17n);
    ledger.tokenBalances.set(key2(USDC, AGENT), 10_000_000n);
    ledger.allowances.set(`${key2(USDC, AGENT)}|${VAULT}`, 3n);
    const reselect = vi.fn();
    const naive = buildDeposit(config, { token: 'USDC', amount: 2_000_000n });
    await expect(
      sendDeposit(
        ledger,
        { signer: directSigner(), broadcast: ledger.broadcast },
        { token: 'USDC', amount: 2_000_000n },
        naive,
        {
          reselect,
          pollMs: 1,
          waitMs: 5,
          sleep: noSleep,
        },
      ),
    ).rejects.toBeInstanceOf(ChainError);
    expect(reselect).not.toHaveBeenCalled();
  });

  it('sendDeposit refuses a step aimed anywhere but the vault or the fee token', async () => {
    const ledger = new Ledger();
    ledger.native.set(AGENT, 10n ** 17n);
    const plan = buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 0n });
    const tampered = plan.map((s) => (s.purpose === 'approve' ? { ...s, to: RECIPIENT } : s));
    await expect(
      sendDeposit(
        ledger,
        { signer: directSigner(), broadcast: ledger.broadcast },
        { token: 'USDC', amount: 5n },
        tampered,
        { pollMs: 1, waitMs: 5, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'invalid_call' });
    expect(ledger.broadcasts).toHaveLength(0);
  });

  it.each([
    [
      'another amount',
      (): DepositStep[] =>
        buildDeposit(config, { token: 'USDC', amount: 6n, currentAllowance: 0n }),
    ],
    [
      'a deposit with native value',
      (p: DepositStep[]) => p.map((s) => (s.purpose === 'deposit' ? { ...s, value: 5n } : s)),
    ],
    [
      'an approve of another amount',
      (p: DepositStep[]) => [
        {
          ...(p[0] as DepositStep),
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [VAULT, 7n] }),
        },
        p[1] as DepositStep,
      ],
    ],
    ['the deposit first', (p: DepositStep[]) => [...p].reverse()],
    ['no deposit', (p: DepositStep[]) => p.slice(0, 1)],
    [
      'a deposit of another token',
      (p: DepositStep[]) => [
        p[0] as DepositStep,
        {
          ...(p[1] as DepositStep),
          data: encodeFeeVaultCall({ functionName: 'deposit', args: [RECIPIENT, 5n] }),
        },
      ],
    ],
  ] as const)(
    'sendDeposit refuses steps that do not match the request: %s',
    async (_name, change) => {
      const ledger = new Ledger();
      ledger.native.set(AGENT, 10n ** 17n);
      ledger.tokenBalances.set(key2(USDC, AGENT), 10_000_000n);
      const plan = buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 0n });
      await expect(
        sendDeposit(
          ledger,
          { signer: directSigner(), broadcast: ledger.broadcast },
          { token: 'USDC', amount: 5n },
          change(plan),
          { pollMs: 1, waitMs: 5, sleep: noSleep },
        ),
      ).rejects.toMatchObject({ code: 'invalid_call' });
      expect(ledger.broadcasts).toHaveLength(0);
    },
  );

  it('sendDeposit without native gas signs and sends nothing', async () => {
    const ledger = new Ledger();
    const plan = buildDeposit(config, { token: 'USDC', amount: 5n, currentAllowance: 0n });
    await expect(
      sendDeposit(
        ledger,
        { signer: directSigner(), broadcast: ledger.broadcast },
        { token: 'USDC', amount: 5n },
        plan,
        { pollMs: 1, waitMs: 5, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'no_gas' });
    expect(ledger.broadcasts).toHaveLength(0);
  });

  it('checkGaslessTopUp: refused before any read while the gasless top-up is off (D-89)', async () => {
    const ledger = new Ledger();
    const reads = vi.spyOn(ledger, 'minDeposit');
    await expect(
      checkGaslessTopUp(ledger, { token: 'USDC', amount: 10_000_000n }),
    ).rejects.toMatchObject({ code: 'gasless_unavailable' });
    expect(reads).not.toHaveBeenCalled();
  });

  it('checkGaslessTopUp: enforces the vault minDeposit once the token is flagged', async () => {
    const flagged: ChainConfig = {
      ...config,
      feeTokens: config.feeTokens.map((t) => ({ ...t, eip3009: true })),
    };
    const ledger = new Ledger(flagged);
    await expect(
      checkGaslessTopUp(ledger, { token: 'USDC', amount: 4_999_999n }),
    ).rejects.toMatchObject({ code: 'below_min_deposit' });
    await expect(checkGaslessTopUp(ledger, { token: 'USDC', amount: 5_000_000n })).resolves.toEqual(
      {
        minDeposit: 5_000_000n,
      },
    );
  });
});

it('test setup: the zero address is not the payer', () => {
  expect(AGENT).not.toBe(ZERO_ADDRESS);
});
