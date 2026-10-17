// The policy engine (07 §2; 06 §3; G-6). `evaluate(policy, action, context)` is pure: no clock, no
// store, no I/O, and it never changes its inputs, so every rule has a table test.
//
// Rules: contacts and envelopes; the `commitments` rule with its auto-accept limits (M1-20,
// commitments.ts); key disclosure; automatic receipts; and (M1-7i) files (allowed folders, size
// caps, `files.storage`, D-48) and proofs (`notarize`, `perActionMaxUSD`, `dailyBudgetUSD` over the
// rolling 24 h window of G-7, and the per-contact rules of G-32 in the 06 §3 evaluation steps). The
// budget ledger and the resolved folders come in as context; the check and the reservation run in
// one store transaction in budget.ts.
//
// G-6 (06 §3): the loaded policy is one of three modes. `defaults` only while no version was ever
// applied and no row exists; `signed` for a stored policy that verified on load; `fail_closed`
// otherwise. A fail-closed policy carries no document, so no decision value can be read from the
// defaults or from an invalid row: every paid action, commitment and owner-gated action needs
// approval, unknown senders are queued, no `contacts.allowed` list, contact rule or auto-accept
// applies (an unreadable deny becomes approval, never allow), and limits that grant nothing stay at
// the built-in hard caps of FAIL_CLOSED_LIMITS.
import {
  MAX_INLINE_FILE_BYTES,
  POLICY_DEFAULTS,
  isUsdAmount,
  parseUsd,
  type Policy,
} from '@agentlink/types';
import { evaluateCommitment, type CommitmentFacts } from './commitments.js';
import { CoreError } from './errors.js';

/** A policy document as the engine reads it (06 §3 JSON form). */
export type PolicyDocument = Policy | typeof POLICY_DEFAULTS;

/** Why a stored policy is not used (G-6). Fixed codes. */
export type PolicyProblem =
  | 'mark_unavailable'
  | 'missing'
  | 'unreadable'
  | 'invalid'
  | 'agent_mismatch'
  | 'owner_mismatch'
  | 'signature_invalid'
  | 'rolled_back'
  | 'mark_mismatch'
  | 'tampered'
  | 'identity_unavailable';

export type EffectivePolicy =
  | { readonly mode: 'defaults'; readonly policy: PolicyDocument }
  | { readonly mode: 'signed'; readonly policy: PolicyDocument; readonly version: number }
  | { readonly mode: 'fail_closed'; readonly problem: PolicyProblem };

export type PolicyDecision = 'allow' | 'approval' | 'deny';

/** What the core is about to do. Built by the core from verified data, never from inbound text. */
export type PolicyAction =
  /** `agentlink_accept_invite` (contacts.acceptInvites). */
  | { readonly kind: 'invite.accept' }
  /** An inbound envelope after its signature checks: from a paired contact or an unknown sender. */
  | {
      readonly kind: 'envelope.receive';
      readonly sender:
        { readonly kind: 'contact'; readonly contact: string } | { readonly kind: 'unknown' };
      readonly sizeBytes: number;
    }
  /** An outbound envelope to a paired contact. */
  | { readonly kind: 'envelope.send'; readonly contact: string; readonly sizeBytes: number }
  /**
   * A commitment: its scope and stored terms, or a receipt without terms (04 §3.4.2, M1-20). The
   * decision only: execution uses evaluateCommitment and recheckCommitmentGrant (IR-M1-20-1 F02).
   */
  | { readonly kind: 'commitment'; readonly facts: CommitmentFacts }
  /** A paid proof action (06 §3 `proofs`, contact rules, daily budget). */
  | ProofAction
  /** Sending a local file (`agentlink_send` with `path`): folder, size cap and storage. */
  | FileSendAction
  /** Saving a received file (`agentlink_fetch_file`): the size cap. */
  | { readonly kind: 'file.receive'; readonly sizeBytes: number }
  /** Disclosing a content key (proofs.allowKeyDisclosure). */
  | { readonly kind: 'key.disclose' }
  /** Signing a DELIVERED or OPENED receipt without being asked (receipts.*). */
  | { readonly kind: 'receipt.auto'; readonly receipt: 'delivered' | 'opened' };

/**
 * A paid proof. Built by the core from verified data: the fee quote and the counterparty's state in
 * the contact book, never from inbound text.
 */
export interface ProofAction {
  readonly kind: 'proof';
  /** The fee in USD, the total including any integrator fee (06 §3 step 3). A USD amount. */
  readonly feeUsd: string;
  /** The Record's `maxFee` valued 1:1 in USD (D-46): what the ledger reserves (step 4). */
  readonly maxFeeUsd: string;
  /**
   * The other agent of the envelope being recorded, or null. `ruleEligible` is true only while it is
   * a paired contact that is not blocked or revoked (06 §3 "Where it applies").
   */
  readonly counterparty: { readonly contact: string; readonly ruleEligible: boolean } | null;
}

/** A local file to send. `realpath` is the path resolved with realpath by the core (04 §4). */
export interface FileSendAction {
  readonly kind: 'file.send';
  readonly sizeBytes: number;
  readonly realpath: string;
}

/** One budget ledger row as the engine reads it (07 §3.5). Validated here, never trusted. */
export interface BudgetEntryView {
  readonly t: number;
  readonly ledgerEpoch: number;
  readonly state: 'reserved' | 'charged' | 'released';
  readonly reservedUsd: string;
  readonly chargedUsd: string | null;
}

/** The budget ledger of the current epoch (07 §3.5), or broken (missing, unreadable, marked). */
export type BudgetLedgerView =
  | { readonly status: 'broken' }
  | {
      readonly status: 'ok';
      readonly epoch: number;
      readonly newestT: number;
      readonly entries: readonly BudgetEntryView[];
    };

/** Facts the core passes in, so `evaluate` stays pure. */
export interface PolicyContext {
  /**
   * Envelopes already accepted from this contact in the sliding hour (07 §3.2 rate_counters), not
   * counting this one. Required for `envelope.receive` from a contact.
   */
  readonly contactEnvelopesLastHour?: number;
  /** Unix seconds. Required for a proof under a verified policy (the budget window). */
  readonly now?: number;
  /** The budget ledger. Required for a proof under a verified policy. */
  readonly ledger?: BudgetLedgerView;
  /**
   * The policy's `files.allowedFolders`, each resolved with realpath by the core (04 §4). Required
   * for `file.send` when the policy allows a folder; ignored when it allows none or fails closed.
   */
  readonly allowedFolderRealpaths?: readonly string[];
  /** Own storage is configured and selected (07 §5.6). Required above the inline size. */
  readonly ownStorageConfigured?: boolean;
  /** The encrypted drop can take this file now (size cap and weekly quota, D-48). Same. */
  readonly dropCanTake?: boolean;
}

/** The defaults (06 §3), only while no policy version was ever applied and no row exists (G-6). */
export const POLICY_DEFAULTS_EFFECTIVE: EffectivePolicy = Object.freeze({
  mode: 'defaults',
  policy: POLICY_DEFAULTS,
});

/** The limits that grant nothing, as the engine and the core apply them (06 §3). */
export interface PolicyLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxSendBytes: number;
  readonly maxReceiveBytes: number;
  readonly rateLimitPerContactPerHour: number;
  readonly defaultExpiryDays: number;
  readonly deleteAfter: 'expiry' | 'receipt';
  readonly allowedFolders: readonly string[];
  readonly autoDelivered: boolean;
  readonly autoOpened: boolean;
}

const KB = 1024;
const MB = 1024 * 1024;

/**
 * The hard caps under G-6 fail closed (06 §3): the built-in values of the 06 §3 listing, written out
 * here so the fail-closed path never reads the defaults document. No folder, no automatic receipt.
 */
export const FAIL_CLOSED_LIMITS: PolicyLimits = Object.freeze({
  maxEnvelopeBytes: 24 * KB,
  maxSendBytes: 100 * MB,
  maxReceiveBytes: 200 * MB,
  rateLimitPerContactPerHour: 120,
  defaultExpiryDays: 7,
  deleteAfter: 'expiry',
  allowedFolders: Object.freeze([]) as readonly string[],
  autoDelivered: false,
  autoOpened: false,
});

/** The limits of a loaded policy: its own when verified or defaults, the hard caps otherwise. */
export function policyLimits(effective: EffectivePolicy): PolicyLimits {
  if (effective.mode === 'fail_closed') return FAIL_CLOSED_LIMITS;
  const p = effective.policy;
  return {
    maxEnvelopeBytes: p.envelopes.maxEnvelopeKB * KB,
    maxSendBytes: p.files.maxSendSizeMB * MB,
    maxReceiveBytes: p.files.maxReceiveSizeMB * MB,
    rateLimitPerContactPerHour: p.contacts.rateLimitPerContactPerHour,
    defaultExpiryDays: p.files.defaultExpiryDays,
    deleteAfter: p.files.deleteAfter,
    allowedFolders: p.files.allowedFolders,
    autoDelivered: p.receipts.autoDelivered,
    autoOpened: p.receipts.autoOpened,
  };
}

function hourlyCount(context: PolicyContext | undefined): number {
  const n = context?.contactEnvelopesLastHour;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new CoreError(
      'policy_context_invalid',
      'The policy check needs the hourly envelope count for this contact.',
    );
  }
  return n;
}

/** `contacts.allowed`: "paired", or a sorted list of agent IDs (06 §3). */
function isAllowedContact(policy: PolicyDocument, contact: string): boolean {
  const allowed = policy.contacts.allowed;
  return allowed === 'paired' || (allowed as readonly string[]).includes(contact);
}

/**
 * What a paired contact's envelope gets while the policy fails closed (06 §3, G-6; D-70, decided by
 * the owner on 2026-10-15, IR-M1-7d-1 F-1): `contacts.allowed` reads as "paired", so a paired
 * contact may Talk (receive and send) without approval, within the hard caps. Residual: a narrower
 * `allowed` list is not honoured while the policy is invalid. Commitments, paid actions and
 * owner-gated actions still need approval, and unknown senders are still queued.
 */
export const FAIL_CLOSED_CONTACTS = 'paired' as 'strict' | 'paired';

/** A paired contact's envelope while the policy fails closed (see FAIL_CLOSED_CONTACTS). */
const failClosedContact = (): PolicyDecision =>
  FAIL_CLOSED_CONTACTS === 'paired' ? 'allow' : 'approval';

const unknownSender = (policy: PolicyDocument): PolicyDecision =>
  policy.contacts.unknownSenders === 'drop' ? 'deny' : 'approval';

const contextInvalid = (): CoreError =>
  new CoreError('policy_context_invalid', 'The policy check is missing a required fact.');

// --- proofs (06 §3 `proofs`, "Per-contact rules", "Daily budget window"; G-7, G-32) ---------------

/** The rolling budget window (06 §3, G-7): an entry counts while `t > now − 86 400`. */
export const BUDGET_WINDOW_SECONDS = 86_400;

/** Why a proof needs the owner, for the approval card and "Remember for this contact" (06 §3). */
export type ProofTrigger =
  'policy_invalid' | 'notarize' | 'per_action' | 'budget' | 'ledger_broken';

export interface ProofEvaluation {
  readonly decision: PolicyDecision;
  readonly triggers: readonly ProofTrigger[];
}

const LEDGER_STATES: readonly string[] = ['reserved', 'charged', 'released'];
const isTime = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * The amount spent in the window, as exact micro-dollars, or 'broken' (07 §3.5 "Broken ledger"):
 * a state outside the enum, an amount that is not a USD amount, a `charged` row without its amount,
 * a row from a later epoch, or `now` before `newestT`. A broken ledger is never an empty sum.
 */
export function budgetSpentMicros(view: BudgetLedgerView, now: number): bigint | 'broken' {
  if (view.status !== 'ok') return 'broken';
  if (!isTime(view.epoch) || !isTime(view.newestT) || !isTime(now) || now < view.newestT) {
    return 'broken';
  }
  let spent = 0n;
  for (const e of view.entries) {
    if (!isTime(e.t) || !isTime(e.ledgerEpoch) || e.ledgerEpoch > view.epoch) return 'broken';
    if (!LEDGER_STATES.includes(e.state) || !isUsdAmount(e.reservedUsd)) return 'broken';
    if (e.chargedUsd !== null && !isUsdAmount(e.chargedUsd)) return 'broken';
    if (e.state === 'charged' && e.chargedUsd === null) return 'broken';
    if (e.ledgerEpoch !== view.epoch || e.t <= now - BUDGET_WINDOW_SECONDS) continue;
    if (e.state === 'reserved') spent += parseUsd(e.reservedUsd);
    else if (e.state === 'charged' && e.chargedUsd !== null) spent += parseUsd(e.chargedUsd);
  }
  return spent;
}

function proofFees(action: ProofAction): { fee: bigint; maxFee: bigint } {
  if (!isUsdAmount(action.feeUsd) || !isUsdAmount(action.maxFeeUsd)) throw contextInvalid();
  const fee = parseUsd(action.feeUsd);
  const maxFee = parseUsd(action.maxFeeUsd);
  // The reservation must cover the fee, or the window would under-count it.
  if (fee > maxFee) throw contextInvalid();
  return { fee, maxFee };
}

/**
 * The 06 §3 evaluation for a proof action: the strictest outcome of the steps, with every step that
 * asked for the owner. Pure. Rules are read only from a verified policy; under G-6 fail closed the
 * result is approval (an unreadable deny is not trusted), and no rule or budget is read.
 */
export function evaluateProof(
  effective: EffectivePolicy,
  action: ProofAction,
  context?: PolicyContext,
): ProofEvaluation {
  const { fee, maxFee } = proofFees(action);
  if (effective.mode === 'fail_closed') {
    return { decision: 'approval', triggers: ['policy_invalid'] };
  }
  const proofs = effective.policy.proofs;
  // Step 1: a global deny always wins.
  if (proofs.notarize === 'deny') return { decision: 'deny', triggers: ['notarize'] };
  const cp = action.counterparty;
  const rule =
    cp !== null && cp.ruleEligible
      ? effective.policy.contactRules.find((r) => r.contact === cp.contact)
      : undefined;
  // Step 2: the rule's notarize replaces the global one.
  const notarize = rule?.proofs.notarize ?? proofs.notarize;
  if (notarize === 'deny') return { decision: 'deny', triggers: ['notarize'] };
  const now = context?.now;
  const view = context?.ledger;
  if (!isTime(now) || view === undefined) throw contextInvalid();
  const triggers: ProofTrigger[] = [];
  if (notarize === 'approval') triggers.push('notarize');
  // Step 3: the rule's per-action maximum replaces the global one; the fee is compared.
  const perActionMax = parseUsd(rule?.proofs.perActionMaxUSD ?? proofs.perActionMaxUSD);
  if (fee > perActionMax) triggers.push('per_action');
  // Step 4: always the global budget; spent + the reserved maximum fee above it asks the owner.
  const spent = budgetSpentMicros(view, now);
  if (spent === 'broken') triggers.push('ledger_broken');
  else if (spent + maxFee > parseUsd(proofs.dailyBudgetUSD)) triggers.push('budget');
  return { decision: triggers.length === 0 ? 'allow' : 'approval', triggers };
}

// --- files (06 §2.3, §3 `files`, D-48) ------------------------------------------------------------

export type FileStorage = 'inline' | 'drop' | 'own';
export type FileSendRefusal = 'too_large' | 'no_folder' | 'outside_folder' | 'needs_storage';
export type FileSendEvaluation =
  | { readonly decision: 'allow'; readonly storage: FileStorage }
  | { readonly decision: 'deny'; readonly reason: FileSendRefusal };

const WINDOWS_ABS = /^[A-Za-z]:\\/;

/** Splits a clean absolute path into segments, or undefined (relative, `.`, `..`, empty, NUL). */
function pathSegments(path: string): { root: string; parts: string[] } | undefined {
  let root: string;
  let rest: string;
  let sep: string;
  if (path.startsWith('/')) {
    root = '/';
    rest = path.slice(1);
    sep = '/';
  } else if (WINDOWS_ABS.test(path)) {
    root = path.slice(0, 3).toLowerCase();
    rest = path.slice(3);
    sep = '\\';
  } else {
    return undefined;
  }
  if (rest.endsWith(sep)) rest = rest.slice(0, -1);
  const parts = rest === '' ? [] : rest.split(sep);
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\u0000'))) {
    return undefined;
  }
  return { root, parts };
}

/**
 * True when `realpath` is strictly inside `folder`, both already resolved with realpath (04 §4).
 * Compares whole segments, so `/a/bc` is not inside `/a/b`, and refuses anything that is not a
 * clean absolute path. The folder itself is not inside itself.
 */
export function isInsideFolder(realpath: string, folder: string): boolean {
  const p = pathSegments(realpath);
  const f = pathSegments(folder);
  if (p === undefined || f === undefined || p.root !== f.root) return false;
  if (p.parts.length <= f.parts.length) return false;
  return f.parts.every((seg, i) => p.parts[i] === seg);
}

function storageFor(
  policy: PolicyDocument,
  sizeBytes: number,
  context: PolicyContext | undefined,
): FileSendEvaluation {
  if (sizeBytes <= MAX_INLINE_FILE_BYTES) return { decision: 'allow', storage: 'inline' };
  const own = context?.ownStorageConfigured;
  const drop = context?.dropCanTake;
  if (typeof own !== 'boolean' || typeof drop !== 'boolean') throw contextInvalid();
  const needs = { decision: 'deny', reason: 'needs_storage' } as const;
  switch (policy.files.storage) {
    case 'own':
      return own ? { decision: 'allow', storage: 'own' } : needs;
    case 'drop':
      return drop ? { decision: 'allow', storage: 'drop' } : needs;
    case 'auto':
      // Own storage when configured; no silent fallback from configured own storage to the drop.
      if (own) return { decision: 'allow', storage: 'own' };
      return drop ? { decision: 'allow', storage: 'drop' } : needs;
  }
}

/**
 * `agentlink_send` with `path` (06 §2.3, §3): the size cap, then an allowed folder (none by default,
 * which the tool reports as needs_setup), then where the file goes (`files.storage`, D-48). Under
 * G-6 fail closed no folder is allowed, so nothing is uploaded. Pure.
 */
export function evaluateFileSend(
  effective: EffectivePolicy,
  action: FileSendAction,
  context?: PolicyContext,
): FileSendEvaluation {
  const limits = policyLimits(effective);
  if (!Number.isSafeInteger(action.sizeBytes) || action.sizeBytes < 0) throw contextInvalid();
  if (action.sizeBytes > limits.maxSendBytes) return { decision: 'deny', reason: 'too_large' };
  if (effective.mode === 'fail_closed' || limits.allowedFolders.length === 0) {
    return { decision: 'deny', reason: 'no_folder' };
  }
  const folders: unknown = context?.allowedFolderRealpaths;
  if (!Array.isArray(folders)) throw contextInvalid();
  const inside = folders.some(
    (f: unknown) => typeof f === 'string' && isInsideFolder(action.realpath, f),
  );
  if (!inside) return { decision: 'deny', reason: 'outside_folder' };
  return storageFor(effective.policy, action.sizeBytes, context);
}

/**
 * allow | approval | deny for one action. Pure and deterministic. Throws only when a required
 * context fact is missing (`policy_context_invalid`), never guesses one.
 */
export function evaluate(
  effective: EffectivePolicy,
  action: PolicyAction,
  context?: PolicyContext,
): PolicyDecision {
  const limits = policyLimits(effective);
  const policy = effective.mode === 'fail_closed' ? undefined : effective.policy;

  switch (action.kind) {
    case 'invite.accept':
      return policy?.contacts.acceptInvites === 'auto' ? 'allow' : 'approval';

    case 'envelope.receive': {
      if (action.sizeBytes > limits.maxEnvelopeBytes) return 'deny';
      if (action.sender.kind === 'unknown') {
        // Fail closed: queued for the owner, never dropped (06 §3).
        return policy === undefined ? 'approval' : unknownSender(policy);
      }
      const count = hourlyCount(context);
      // The Nth envelope of the hour passes; the N + 1th is dropped (07 §3.2, decided at #44).
      if (count >= limits.rateLimitPerContactPerHour) return 'deny';
      if (policy === undefined) return failClosedContact();
      return isAllowedContact(policy, action.sender.contact) ? 'allow' : unknownSender(policy);
    }

    case 'envelope.send':
      if (action.sizeBytes > limits.maxEnvelopeBytes) return 'deny';
      if (policy === undefined) return failClosedContact();
      return isAllowedContact(policy, action.contact) ? 'allow' : 'deny';

    case 'commitment': {
      // Only the decision. Running a commitment must use evaluateCommitment, which returns the grant
      // to record, and recheckCommitmentGrant before each part (M1-32; IR-M1-20-1 F02). A void
      // (APPROVAL_VOID) reads as deny here: nothing is sent or signed.
      const d = evaluateCommitment(effective, action.facts).decision;
      return d === 'void' ? 'deny' : d;
    }

    case 'proof':
      return evaluateProof(effective, action, context).decision;

    case 'file.send':
      return evaluateFileSend(effective, action, context).decision;

    case 'file.receive':
      if (!Number.isSafeInteger(action.sizeBytes) || action.sizeBytes < 0) throw contextInvalid();
      if (action.sizeBytes > limits.maxReceiveBytes) return 'deny';
      // Under fail closed, file access is owner-gated and no inbox folder can be read (06 §3).
      return policy === undefined ? 'approval' : 'allow';

    case 'key.disclose':
      return policy?.proofs.allowKeyDisclosure === 'deny' ? 'deny' : 'approval';

    case 'receipt.auto': {
      const on = action.receipt === 'delivered' ? limits.autoDelivered : limits.autoOpened;
      return on ? 'allow' : 'deny';
    }
  }
}
