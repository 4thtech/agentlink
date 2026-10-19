// Submission with failover and direct mode, inclusion tracking and the 04 §5 replacement check
// (07 §6.2, §7; 03 §4.3; 05 §3.2, §3.3; 04 §5, §7; M1-4c).
//
// Trust: a submitter can only censor (04 §7). Nothing here believes its answer. Whether an item is
// on-chain, refused or still open is read from the chain through the ChainState port:
// - a wrong transaction hash, a silent drop or an answer about some other record leaves our record
//   absent on-chain after the wait, so the next submitter gets the SAME signed item (idempotent);
// - a `failed` answer is checked: on-chain already (success, nothing signed again), or the
//   contract's own simulation now refuses it (that refusal is the result), or neither (a false
//   answer: the next submitter);
// - success is `getRecord` showing our record (its struct hash) or our receipt type.
// After every submitter, direct mode (when configured) sends from the agent's own account,
// simulated first: the same one-item `notarizeBatch` when its credits cover the fee, otherwise
// `notarizeDirect`, which pays now (an exact `approve(maxFee)` first for an ERC-20 fee token, reset
// to 0 first when another allowance is set; `maxFee` as the value for the native coin);
// `acknowledge` for a receipt.
//
// This module signs nothing and never builds a replacement. `replacementAllowed` is the 04 §5 test
// a caller must pass before it signs one (new nonce, fresh salt, new deadline).
//
// Credits (IR-M1-26-1, 07 §6.3): after every paid action and after a refusal for missing credits
// (`InsufficientCredits` or a reverted simulation) the selector's cache is cleared and, when the
// caller gave `reselect`, the chain is selected again exactly once. A paid path never relies on a
// cached funded detection after a refusal.
import {
  encodeHex0x,
  parseReceipt,
  parseRecord,
  recordStructHash,
  type OccReceipt,
  type OccRecord,
} from '@4thtech-io/crypto';
import {
  pollChain,
  pollPlan,
  sendDirect,
  waitForTx,
  type DirectMode,
  type DirectSend,
  type DirectSendOptions,
  type PollOptions,
} from '../clients/direct.js';
import { ChainError } from '../clients/errors.js';
import type { ChainState, ContractTx, StoredRecord } from '../clients/state.js';
import { offeredTokenAt } from '../fees/tokens.js';
import { ChainInputError, computeRecordId, type Hex } from '../ids/index.js';
import type { ChainSelection } from '../select/pick.js';
import { MAX_SUBMITTER_URLS, type SubmitterClient } from './client.js';
import { isSubmitSignature, type SubmitResponse } from './wire.js';

export interface ProofSubmitterOptions extends PollOptions {
  /** Chain reads for the chain the items are signed for. */
  readonly state: ChainState;
  /** Submitters, tried in order; at most 5. Each may itself hold a list of URLs. */
  readonly submitters?: readonly SubmitterClient[];
  /** Direct mode: the agent's own account pays the gas (03 §4.3). */
  readonly direct?: DirectMode;
  readonly directOptions?: DirectSendOptions;
  /** The chain selector's cache (createChainSelector): cleared after paying or a credit refusal. */
  readonly selector?: { clear(): void };
  /** Selects the paying chain again; called once after a refusal for missing credits. */
  readonly reselect?: () => Promise<ChainSelection>;
}

/** How an item reached its on-chain state. `chain`: it was already there before we sent it. */
export type ProofVia = 'chain' | 'submitter' | 'direct';

export type ProofOutcome =
  | {
      readonly status: 'recorded';
      readonly id: string;
      readonly recordId: Hex;
      readonly via: ProofVia;
      /** Present at the configured confirmation depth (07 §6.1 `confirmations`). */
      readonly confirmed: boolean;
    }
  /** The contract refuses the charge (`InsufficientCredits`); `selection` is the one re-selection. */
  | {
      readonly status: 'needs_credits';
      readonly id: string;
      readonly recordId: Hex;
      readonly selection?: ChainSelection;
    }
  /**
   * Not on-chain after every route. The same signed item may be sent again later; a replacement
   * only after `replacementAllowed` (04 §5).
   */
  | { readonly status: 'pending'; readonly id: string; readonly recordId: Hex }
  /** The contract's own simulation refuses the item (`Expired`, `InvalidSignature`, …). */
  | {
      readonly status: 'failed';
      readonly id: string;
      readonly recordId: Hex;
      readonly error: string;
      /** For a paid item: the one re-selection after the refusal (07 §6.3). */
      readonly selection?: ChainSelection;
    }
  /** The record ID holds another record, or the receipt's conflicting type is set. */
  | { readonly status: 'conflict'; readonly id: string; readonly recordId: Hex };

export interface ProofSubmitter {
  notarize(item: { readonly record: unknown; readonly signature: unknown }): Promise<ProofOutcome>;
  acknowledge(item: {
    readonly receipt: unknown;
    readonly signature: unknown;
  }): Promise<ProofOutcome>;
}

type Seen = 'match' | 'absent' | 'conflict';

/** One signed item and what the flow needs to know about it. */
interface Item {
  readonly id: string;
  readonly recordId: Hex;
  /** Records are paid; receipts are covered by the record fee (05 §3.3). */
  readonly paid: boolean;
  seen(stored: StoredRecord | null): Seen;
  /** The one-item batch call, as the submitter would send it, simulated from the signer. */
  readonly batch: ContractTx;
  /** The direct-mode call from `from`, or undefined where direct mode cannot send it. */
  direct(from: Hex): Omit<ContractTx, 'from'> | undefined;
  /** A record the signer can pay for now with `notarizeDirect` (05 §3.2). */
  readonly payNow?: {
    readonly signer: Hex;
    readonly feeToken: Hex;
    readonly maxFee: bigint;
    readonly call: Omit<ContractTx, 'from' | 'value'>;
  };
  send(sub: SubmitterClient): Promise<SubmitResponse>;
}

const recordTuple = (r: OccRecord) => ({
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

const receiptTuple = (r: OccReceipt) => ({
  signer: r.signer as Hex,
  recordId: r.recordId as Hex,
  receiptType: r.receiptType,
  salt: r.salt as Hex,
  deadline: BigInt(r.deadline),
});

/** ACCEPTED (3) and REJECTED (4) exclude each other (05 §3.3). */
const conflictingType = (t: number): number => (t === 3 ? 4 : t === 4 ? 3 : 0);

function receiptSeen(stored: StoredRecord | null, receiptType: number): Seen {
  if (stored === null) return 'absent';
  if ((stored.receiptAt[receiptType - 1] ?? 0n) !== 0n) return 'match';
  const other = conflictingType(receiptType);
  if (other !== 0 && (stored.receiptAt[other - 1] ?? 0n) !== 0n) return 'conflict';
  return 'absent';
}

function strict<T>(parse: (v: unknown) => T, value: unknown, what: string): T {
  try {
    return parse(value);
  } catch {
    // The crypto parser's message may describe the input; ours never does.
    throw new ChainInputError('invalid_item', `${what}: not in the 05 §3.1 JSON form`);
  }
}

function signatureOf(value: unknown): Hex {
  if (!isSubmitSignature(value)) {
    throw new ChainInputError('invalid_item', 'signature: 0x + lowercase hex');
  }
  return value;
}

function recordItem(state: ChainState, value: unknown, sig: unknown): Item {
  const record = strict(parseRecord, value, 'record');
  const signature = signatureOf(sig);
  const notary = state.config.contracts.notary;
  const recordId = computeRecordId(
    state.config.chainId,
    notary,
    record.signer,
    BigInt(record.nonce),
  );
  const mine = encodeHex0x(recordStructHash(record)).toLowerCase();
  const tuple = recordTuple(record);
  return {
    id: recordId,
    recordId,
    paid: true,
    seen: (stored) =>
      stored === null ? 'absent' : stored.recordStructHash === mine ? 'match' : 'conflict',
    batch: {
      contract: 'notary',
      to: notary as Hex,
      from: record.signer as Hex,
      value: 0n,
      functionName: 'notarizeBatch',
      args: [[tuple], [signature]],
    },
    // With credits, direct mode sends the same one-item batch from the agent's own account: it
    // charges the signer's credits. Only the signer's own account is used, never another's gas.
    direct: (from) =>
      from === record.signer
        ? {
            contract: 'notary',
            to: notary as Hex,
            value: 0n,
            functionName: 'notarizeBatch',
            args: [[tuple], [signature]],
          }
        : undefined,
    // Without credits, notarizeDirect pays now: only the signer may send it; it deposits exactly
    // maxFee of an ERC-20 fee token through the signer's allowance to the vault, or the native
    // value sent, then charges the fee (the rest stays as the signer's credits).
    payNow: {
      signer: record.signer as Hex,
      feeToken: record.feeToken as Hex,
      maxFee: BigInt(record.maxFee),
      call: {
        contract: 'notary',
        to: notary as Hex,
        functionName: 'notarizeDirect',
        args: [tuple],
      },
    },
    send: (sub) => sub.notarize(state.config.chainId, [{ record, signature }]),
  };
}

function receiptItem(state: ChainState, value: unknown, sig: unknown): Item {
  const receipt = strict(parseReceipt, value, 'receipt');
  const signature = signatureOf(sig);
  const notary = state.config.contracts.notary as Hex;
  const tuple = receiptTuple(receipt);
  return {
    id: `${receipt.recordId}:${String(receipt.receiptType)}`,
    recordId: receipt.recordId as Hex,
    paid: false,
    seen: (stored) => receiptSeen(stored, receipt.receiptType),
    batch: {
      contract: 'notary',
      to: notary,
      from: receipt.signer as Hex,
      value: 0n,
      functionName: 'acknowledgeBatch',
      args: [[tuple], [signature]],
    },
    // Anyone may send a signed receipt (05 §3.3: the signature and commitment are checked).
    direct: () => ({
      contract: 'notary',
      to: notary,
      value: 0n,
      functionName: 'acknowledge',
      args: [tuple, signature],
    }),
    send: (sub) => sub.acknowledge(state.config.chainId, [{ receipt, signature }]),
  };
}

/** Present at the configured depth below the head (07 §6.1 `confirmations`). */
async function confirmedAt(state: ChainState, item: Pick<Item, 'recordId' | 'seen'>) {
  const depth = BigInt(state.config.confirmations);
  const head = await state.block('latest');
  if (head.number < depth) return false;
  return item.seen(await state.getRecord(item.recordId, head.number - depth)) === 'match';
}

export function createProofSubmitter(options: ProofSubmitterOptions): ProofSubmitter {
  const { state } = options;
  const submitters = [...(options.submitters ?? [])];
  if (submitters.length > MAX_SUBMITTER_URLS) {
    throw new ChainInputError('too_many_submitters', 'at most 5 submitters');
  }
  // Validate the poll settings up front: a bad value must not look like a submitter failure.
  pollPlan(options);

  async function run(item: Item): Promise<ProofOutcome> {
    const base = { id: item.id, recordId: item.recordId };
    const seenNow = async (): Promise<Seen> => item.seen(await state.getRecord(item.recordId));

    const recorded = async (via: ProofVia): Promise<ProofOutcome> => {
      if (item.paid && via !== 'chain') options.selector?.clear();
      let confirmed = false;
      try {
        confirmed = await confirmedAt(state, item);
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
      }
      return Object.freeze({ status: 'recorded', ...base, via, confirmed });
    };
    const conflict = (): ProofOutcome => Object.freeze({ status: 'conflict', ...base });
    const pending = (): ProofOutcome => Object.freeze({ status: 'pending', ...base });

    /** The contract's own refusal: credits, an item now on-chain, or a final failure. */
    const refused = async (error: string): Promise<ProofOutcome | undefined> => {
      if (error === 'EnforcedPause') return undefined; // held, not failed (05 §3.3)
      if (error === 'RecordExists' || error === 'ReceiptExists') {
        const s = await seenNow();
        return s === 'match' ? recorded('chain') : conflict();
      }
      if (!item.paid) return Object.freeze({ status: 'failed', ...base, error });
      // A refusal of a paid item: never pay from the cached detection; select again once.
      options.selector?.clear();
      const selection = options.reselect ? await options.reselect() : undefined;
      const extra = selection === undefined ? {} : { selection };
      if (error === 'InsufficientCredits') {
        return Object.freeze({ status: 'needs_credits', ...base, ...extra });
      }
      return Object.freeze({ status: 'failed', ...base, error, ...extra });
    };

    const direct = options.direct;
    const from = direct?.signer.address.toLowerCase() as Hex | undefined;
    const canPayNow =
      direct !== undefined && item.payNow !== undefined && from === item.payNow.signer;

    /** One direct call, then its receipt on-chain; `not_included` when the wait ran out. */
    const sendAndWait = async (call: Omit<ContractTx, 'from'>): Promise<DirectSend> => {
      const sent = await sendDirect(state, direct as DirectMode, call, options.directOptions);
      if (!sent.ok) return sent;
      const st = await waitForTx(state, sent.txHash, options);
      if (st === 'success') return sent;
      return { ok: false, error: st === 'reverted' ? 'reverted' : 'not_included' };
    };

    /** notarizeDirect from the signer: approve exactly maxFee first, or attach the native value. */
    const payNow = async (): Promise<DirectSend> => {
      const p = item.payNow as NonNullable<Item['payNow']>;
      const offered = offeredTokenAt(state.config, p.feeToken);
      if (offered === undefined) return { ok: false, error: 'fee_token_not_offered' };
      const vault = state.config.contracts.vault as Hex;
      const pay = (value: bigint) =>
        sendDirect(state, direct as DirectMode, { ...p.call, value }, options.directOptions);
      if (offered.token.address === null) return pay(p.maxFee);
      const token = offered.token.address as Hex;
      if ((await state.tokenBalance(token, p.signer)) < p.maxFee) {
        return { ok: false, error: 'InsufficientCredits' };
      }
      const current = await state.allowance(token, p.signer, vault);
      if (current !== p.maxFee) {
        const approve = (value: bigint) =>
          sendAndWait({
            contract: 'erc20',
            to: token,
            value: 0n,
            functionName: 'approve',
            args: [vault, value],
          });
        // Tokens in the USDT style refuse a change between two nonzero allowances.
        if (current !== 0n) {
          const reset = await approve(0n);
          if (!reset.ok) return reset;
        }
        const set = await approve(p.maxFee);
        if (!set.ok) return set;
      }
      return pay(0n);
    };

    /** Polls the chain until the item shows up (or conflicts); undefined when the wait ran out. */
    const landed = () =>
      pollChain(async () => {
        const s = await seenNow();
        return s === 'absent' ? undefined : s;
      }, options);

    // 1. Already on-chain? Then nothing is sent and nothing is charged again (04 §5).
    const before = await seenNow();
    if (before === 'match') return recorded('chain');
    if (before === 'conflict') return conflict();

    // 2. Our own simulation, before any submitter sees the item.
    const sim = await state.simulate(item.batch);
    // Without credits, no submitter can charge the item; direct mode may still pay now.
    const payNowFirst = !sim.ok && sim.error === 'InsufficientCredits' && canPayNow;
    if (!sim.ok && !payNowFirst) {
      const out = await refused(sim.error);
      if (out) return out;
    }

    // 3. Submitters, in order. Their answers only decide what to read next.
    for (const sub of payNowFirst ? [] : submitters) {
      let answer: SubmitResponse;
      try {
        answer = await item.send(sub);
      } catch {
        continue; // unavailable, refused or unparsable: a submitter can only censor
      }
      const mine = answer.items.find((i) => i.id === item.id && i.recordId === item.recordId);
      try {
        if (mine?.status === 'failed') {
          const s = await seenNow();
          if (s === 'match') return await recorded('submitter');
          if (s === 'conflict') return conflict();
          const check = await state.simulate(item.batch);
          if (!check.ok) {
            const out = await refused(check.error);
            if (out) return out;
          }
          continue; // the item still passes: the answer was false
        }
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        continue;
      }
      const s = await landed();
      if (s === 'match') return recorded('submitter');
      if (s === 'conflict') return conflict();
    }

    // 4. Direct mode: the agent's own account, simulated first, only with enough native gas.
    const call = direct && from ? item.direct(from) : undefined;
    if (direct && call) {
      let sent: DirectSend;
      try {
        sent = await sendDirect(state, direct, call, options.directOptions);
        if (!sent.ok && sent.error === 'InsufficientCredits' && canPayNow) sent = await payNow();
      } catch (error) {
        if (!(error instanceof ChainError) || error.code === 'signer_mismatch') throw error;
        return pending();
      }
      if (!sent.ok) {
        if (sent.error === 'no_gas' || sent.error === 'not_included') return pending();
        return (await refused(sent.error)) ?? pending();
      }
      const s = await landed();
      if (s === 'match') return recorded('direct');
      if (s === 'conflict') return conflict();
    }
    return pending();
  }

  return Object.freeze({
    notarize: (item) =>
      Promise.resolve().then(() => run(recordItem(state, item.record, item.signature))),
    acknowledge: (item) =>
      Promise.resolve().then(() => run(receiptItem(state, item.receipt, item.signature))),
  } satisfies ProofSubmitter);
}

/** Where an item stands on-chain: for tracking inclusion after a send (07 §6.2). */
export async function readInclusion(
  state: ChainState,
  item: { readonly recordId: string; readonly record: unknown } | { readonly receipt: unknown },
): Promise<'absent' | 'included' | 'confirmed' | 'conflict'> {
  let tracked: Pick<Item, 'recordId' | 'seen'>;
  if ('receipt' in item) {
    const receipt = strict(parseReceipt, item.receipt, 'receipt');
    tracked = {
      recordId: receipt.recordId as Hex,
      seen: (s) => receiptSeen(s, receipt.receiptType),
    };
  } else {
    const record = strict(parseRecord, item.record, 'record');
    const mine = encodeHex0x(recordStructHash(record)).toLowerCase();
    const recordId = computeRecordId(
      state.config.chainId,
      state.config.contracts.notary,
      record.signer,
      BigInt(record.nonce),
    );
    if (recordId !== String(item.recordId).toLowerCase()) {
      throw new ChainInputError('invalid_item', 'recordId: does not match the record');
    }
    tracked = {
      recordId,
      seen: (s) => (s === null ? 'absent' : s.recordStructHash === mine ? 'match' : 'conflict'),
    };
  }
  const now = tracked.seen(await state.getRecord(tracked.recordId));
  if (now === 'absent' || now === 'conflict') return now;
  return (await confirmedAt(state, tracked)) ? 'confirmed' : 'included';
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The 04 §5 condition for signing a replacement: the earlier item's `deadline` has passed AND the
 * chain at the `finalized` block (on a chain without the tag: `confirmations` below the head),
 * whose timestamp is after that deadline, shows no record for `recordId` (for a receipt: neither
 * its type nor the conflicting ACCEPTED/REJECTED type). Any failed read is `false` (fail closed).
 * Never decided from a submitter's answer.
 */
export async function replacementAllowed(
  state: ChainState,
  item: { readonly recordId: string; readonly deadline: number; readonly receiptType?: number },
): Promise<boolean> {
  if (typeof item.recordId !== 'string' || !BYTES32.test(item.recordId)) {
    throw new ChainInputError('invalid_item', 'recordId: 0x + 64 hex');
  }
  if (!Number.isSafeInteger(item.deadline) || item.deadline < 0) {
    throw new ChainInputError('invalid_item', 'deadline: a non-negative integer');
  }
  const t = item.receiptType;
  if (t !== undefined && (!Number.isInteger(t) || t < 1 || t > 4)) {
    throw new ChainInputError('invalid_item', 'receiptType: 1 to 4');
  }
  try {
    let at;
    if (state.config.finalizedTag) {
      at = await state.block('finalized');
    } else {
      const head = await state.block('latest');
      const depth = BigInt(state.config.confirmations);
      if (head.number < depth) return false;
      at = await state.block(head.number - depth);
    }
    if (at.timestamp <= BigInt(item.deadline)) return false;
    const stored = await state.getRecord(item.recordId.toLowerCase() as Hex, at.number);
    if (t === undefined) return stored === null;
    return receiptSeen(stored, t) === 'absent';
  } catch {
    return false;
  }
}
