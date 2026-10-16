// Approval requests and their one use (04 §3.4.1, §2.5.1, §2.5.2; 06 §2.5; 07 §3 `approvals`;
// M1-7e).
//
// - request(): a tool call outside policy gets a `pending` row. The action passes the strict
//   per-tool schema and, with the summary and the TTL, the whole `approval-request` body schema; the
//   digest is sha256(JCS(action)); `action_json` and `summary` are sealed; the row is written in one
//   store transaction (with the call's idempotency compare-and-set when it has one), then handed to
//   the ApprovalChannel. A pending row authorises nothing.
// - authorize() / use(): an approved ID lets the identical action proceed once. The stored decision
//   is re-verified and the digest recomputed from the call's action (OwnerActions.checkApproval,
//   M1-7d); policy evaluated again at use refuses a call whose rule is now `deny`; the claim is a
//   compare-and-set `approved` → `void` inside the caller's effect transaction, so two uses can
//   never both proceed. A commitment approval is used per part (M1-32), never here.
// - collect(): what the channel holds is unverified data; only OwnerActions.apply can decide.
// - read() / countPending() (M1-7e-3): one approval's state for its own stored action, re-verified
//   (06 §2.5 `agentlink_get_approval`), and the number waiting for the owner (`agentlink_status`).
//   Read-only; a row that does not verify reads `unknown`, never a state that suggests authority.
//
// I-4: nothing here decides, widens or creates an approved approval. The row's `status` only ever
// takes authority away (`void`, `expired`); it never grants it. I-5: the summary is core-built
// template text checked like `approval-request.summary`; errors and log lines are fixed text.
import { canonicalize, encodeBase64url, parseJson, randomBytes } from '@agentlink/crypto';
import {
  APPROVAL_ID_PREFIX,
  APPROVAL_TTL_SECONDS,
  MAX_USD_MICROS,
  approvalActionSchema,
  approvalFeeSchema,
  approvalIdSchema,
  approvalRequestBodySchema,
  commitmentScopeOf,
  formatUsd,
  signedOwnerActionSchema,
  type ApprovalFee,
  type ApprovalToolName,
} from '@agentlink/types';
import type { ApprovalChannel } from './approval-channel.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { IdempotencyRun, IdempotencyService, PreparedEffect } from './idempotency.js';
import type { IdentityService } from './identity.js';
import { computeActionDigest, parseOwnerActionText } from './owner-action.js';
import type { ApprovalCheck, OwnerActionOutcome, OwnerActions } from './owner-actions.js';
import type { PolicyDecision } from './policy-engine.js';
import type { StoreTx } from './store/store.js';

/** 04 §2.4.1: `apr_` + 16 random bytes, base64url. */
const APPROVAL_ID_BYTES = 16;

export interface ApprovalRequestInput {
  /** `{tool, args, context}` (04 §3.4.1), built by the core from verified data. */
  readonly action: unknown;
  /** Core-built template text naming the contact and the action, never inbound text (06 §2.1). */
  readonly summary: string;
  /** For a commitment: the counterparty envelope it answers (07 §3 `answers_envelope_id`). */
  readonly answersEnvelopeId?: string;
  /**
   * For a commitment (M1-32; 07 §3.5): its scope key (one live scope per value) and the parts its
   * decision authorises. The row is written with one `unclaimed` row per part, and an older pending
   * scope with the same key is voided in the same store transaction (04 §3.4.2).
   */
  readonly commitment?: {
    readonly scopeKey: string;
    readonly parts: readonly CommitmentPartRow[];
  };
}

/** A `commitment_parts.part` value (07 §3.5). */
export type CommitmentPartRow = 'envelope' | 'record' | 'receipt';

/**
 * Voids every pending scope with `scopeKey` and its parts (04 §3.4.2: a new scope for the same
 * answered envelope voids an older one that is still pending). Approved scopes are not touched: only
 * an owner signature ends what an owner approved (07 §3.5).
 */
export function voidPendingScopeTx(tx: StoreTx, scopeKey: string, now: number): number {
  let n = 0;
  for (const row of tx.select('approvals', { scope_key: scopeKey, status: 'pending' })) {
    n += tx.update(
      'approvals',
      { approval_id: row.approval_id, status: 'pending' },
      { status: 'void', decided_at: now },
    );
    tx.update(
      'commitment_parts',
      { approval_id: row.approval_id, state: { in: ['unclaimed', 'claimed'] } },
      { state: 'void', void_reason: 'void', updated_at: now },
    );
  }
  return n;
}

/** The `unclaimed` part rows of a new commitment scope (07 §3.5 "Keys"). */
export function insertCommitmentPartsTx(
  tx: StoreTx,
  approvalId: string,
  parts: readonly CommitmentPartRow[],
  now: number,
): void {
  for (const part of parts) {
    tx.insert('commitment_parts', {
      approval_id: approvalId,
      part,
      state: 'unclaimed',
      item_ref: null,
      item_json: null,
      ledger_entry_id: null,
      void_reason: null,
      replacements: 0,
      claimed_at: null,
      done_at: null,
      updated_at: now,
    });
  }
}

/** The `pending_approval` result a tool returns (06 §2.5); `nextStep` is the MCP layer's. */
export interface PendingApproval {
  readonly status: 'pending_approval';
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly summary: string;
  readonly expiresAt: number;
  /** The local approval page or a console link, when the channel has one. */
  readonly url?: string;
}

/**
 * An open request found for an identical action (ApprovalService.findOpen). Only the ID, the
 * re-verified state and the expiry: never the action, the summary or a signed object (I-4, I-5).
 */
export interface OpenApproval {
  readonly approvalId: string;
  readonly status: 'pending' | 'approved';
  readonly expiresAt: number;
}

/** How many open requests findOpen looks at, newest first (a bound on work, not a rule). */
const MAX_OPEN_SCAN = 200;

type CheckRefusal = Extract<ApprovalCheck, { status: 'refused' }>['reason'];

export type ApprovalRefusal =
  | {
      readonly status: 'refused';
      readonly reason: CheckRefusal | 'policy_deny' | 'commitment_scope';
    }
  | { readonly status: 'pending' | 'denied' | 'expired' | 'cancelled' | 'void' };

export type ApprovalAuthorization =
  | {
      readonly status: 'authorized';
      /**
       * Inside the caller's effect transaction: marks the approval used (`approved` → `void`). False
       * means it was used, cancelled, edited or lapsed meanwhile: the caller must abort and write
       * nothing.
       */
      claim(tx: StoreTx): boolean;
    }
  | ApprovalRefusal;

export type ApprovalUse = { readonly status: 'used' } | ApprovalRefusal;

/**
 * One stored approval as read for its own stored action (06 §2.5 `agentlink_get_approval`;
 * M1-7e-3). Minimal by design: never the owner signature, the decision payload, the action, the
 * summary or anything sealed (I-4, I-5). `void` is a request withdrawn before any decision;
 * `used` is an approval that already let its action run once. `unknown` fails closed: `not_found`
 * for no such ID, `invalid` for a row whose stored action or signed objects do not verify (an
 * edited row authorises nothing). The MCP mapping to the 06 §2.5 output is M1-9c.
 */
export type ApprovalState =
  | {
      readonly status:
        'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'used' | 'void';
      /** sha256(JCS(action)), recomputed from the stored action. */
      readonly actionDigest: string;
      readonly expiresAt: number;
      /** The row's `decided_at`, unix seconds, once the owner decided or cancelled. */
      readonly decidedAt?: number;
    }
  | { readonly status: 'unknown'; readonly reason: 'not_found' | 'invalid' };

/**
 * What an open approval is for, so a fresh session can finish it with only the `approvalId`
 * (06 §2.5 `agentlink_get_approval.action`; M1-22). Only structured, schema-checked values: the tool
 * name and, for `agentlink_respond_to_terms` with `accept` or `reject` (no `notarize`), the answered
 * envelope ID and the decision. Never terms, notes, text, paths or links: those can carry inbound or
 * agent-written text (I-5), and an invite link carries the invite secret. It authorises nothing: the
 * call that names the `approvalId` is still checked against the owner-signed digest (I-4).
 */
export type ApprovalResume =
  | {
      readonly tool: 'agentlink_respond_to_terms';
      readonly envelopeId: string;
      readonly decision: 'accept' | 'reject';
    }
  | { readonly tool: ApprovalToolName };

export type CollectOutcome =
  | { readonly status: 'pending' | 'unknown' }
  | OwnerActionOutcome
  | {
      readonly status: 'refused';
      readonly op: string;
      /** The channel holds a signed object for another request: it is not applied from here. */
      readonly reason: 'other_request';
      readonly nonceBurnt: false;
    };

/** A fee quote from the chain package: the Record's `feeToken` and `maxFee` in base units. */
export interface FeeQuote {
  readonly token: string;
  readonly amount: bigint;
  /** The token's decimals, from the chain config (not checkable in @agentlink/types). */
  readonly decimals: number;
}

const UINT256_MAX = (1n << 256n) - 1n;
const MAX_DECIMALS = 77;

/**
 * The approval `context.fee` built from ONE quote, so `amount` and `usd` can never disagree (the
 * types cannot check them against each other; IR-M1-2b-1 F-3). USD at 1:1 for stablecoins (D-46),
 * rounded up to whole micro-dollars, never down, so the owner never sees less than is reserved.
 */
export function feeContextFromQuote(quote: FeeQuote): ApprovalFee {
  const bad = () => new CoreError('fee_quote_invalid', 'The fee quote is not valid.');
  const { amount, decimals } = quote;
  if (typeof amount !== 'bigint' || amount < 0n || amount > UINT256_MAX) throw bad();
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw bad();
  let micros: bigint;
  if (decimals <= 6) {
    micros = amount * 10n ** BigInt(6 - decimals);
  } else {
    const step = 10n ** BigInt(decimals - 6);
    micros = amount / step + (amount % step === 0n ? 0n : 1n);
  }
  if (micros > MAX_USD_MICROS) throw bad();
  const fee = approvalFeeSchema.safeParse({
    token: quote.token,
    amount: amount.toString(),
    usd: formatUsd(micros),
  });
  if (!fee.success) throw bad();
  return fee.data;
}

/** A check that does not let the action proceed, as a use result; undefined when approved. */
function refusalOf(check: ApprovalCheck): ApprovalRefusal | undefined {
  if (check.status === 'refused') return check;
  const status = check.status;
  if (status === 'approved') return undefined;
  return { status };
}

/** Does a signed owner action name this approval (decide, an item of a batch, or a cancel)? */
function namesApproval(value: unknown, approvalId: string): { op: string; names: boolean } | null {
  const shaped = signedOwnerActionSchema.safeParse(value);
  if (!shaped.success) return null;
  const body = shaped.data.body;
  switch (body.op) {
    case 'approval.decide':
    case 'approval.cancel':
      return { op: body.op, names: body.params.approvalId === approvalId };
    case 'approval.decideBatch':
      return { op: body.op, names: body.params.items.some((i) => i.approvalId === approvalId) };
    default:
      return { op: body.op, names: false };
  }
}

export class ApprovalService {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #owner: OwnerActions;
  readonly #channel: ApprovalChannel;
  readonly #idempotency: IdempotencyService;

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    owner: OwnerActions,
    channel: ApprovalChannel,
    idempotency: IdempotencyService,
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#owner = owner;
    this.#channel = channel;
    this.#idempotency = idempotency;
  }

  /**
   * Creates a pending request for `action` (06 §2.5). With `run`, the row is written only under that
   * execution's idempotency lease and joins its effects (07 §3.3).
   */
  async request(
    input: ApprovalRequestInput,
    options: { readonly run?: IdempotencyRun } = {},
  ): Promise<PendingApproval> {
    const view = await this.#identity.get();
    if (view === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet.');
    }
    if (view.revoked) throw new CoreError('identity_revoked', 'This agent has been revoked.');

    const action = approvalActionSchema.safeParse(input.action);
    if (!action.success) {
      throw new CoreError('approval_action_invalid', 'The approval request is not valid.');
    }
    const now = nowOf(this.#ctx);
    const scope = commitmentScopeOf(input.action);
    let expiresAt = now + APPROVAL_TTL_SECONDS;
    if (scope !== undefined) {
      if (typeof scope.expiresAt !== 'number' || scope.expiresAt <= now) {
        throw new CoreError('approval_scope_expired', 'The commitment has already expired.');
      }
      // A request never outlives its scope (G-7, 04 §3.4.1).
      expiresAt = Math.min(expiresAt, scope.expiresAt);
    }
    const approvalId = `${APPROVAL_ID_PREFIX}${encodeBase64url(randomBytes(APPROVAL_ID_BYTES))}`;
    const actionDigest = computeActionDigest(input.action);
    // The whole `approval-request` body: the summary rule, the TTL, and a commitment scope that
    // belongs to this agent and starts now (04 §3.4.1, §3.4.2).
    const body = approvalRequestBodySchema.safeParse({
      approvalId,
      agent: view.agentId,
      action: input.action,
      actionDigest,
      summary: input.summary,
      requestedAt: now,
      expiresAt,
    });
    if (!body.success) {
      const summary = body.error.issues.some((i) => i.path[0] === 'summary');
      throw summary
        ? new CoreError('approval_summary_invalid', 'The approval summary is not valid.')
        : new CoreError('approval_action_invalid', 'The approval request is not valid.');
    }
    if (
      (input.answersEnvelopeId !== undefined || input.commitment !== undefined) &&
      scope === undefined
    ) {
      throw new CoreError('approval_action_invalid', 'The approval request is not valid.');
    }
    const commitment = input.commitment;

    const key = [approvalId];
    const actionText = canonicalize(input.action);
    const sealedAction = await seal(this.#ctx, 'approvals', 'action_json', key, actionText);
    const sealedSummary = await seal(this.#ctx, 'approvals', 'summary', key, input.summary);
    const run = options.run;
    let prepared: PreparedEffect | undefined;
    if (run !== undefined) prepared = await this.#idempotency.prepareEffect(run, [approvalId]);

    const written = await this.#ctx.store.transaction((tx) => {
      if (run !== undefined && !this.#idempotency.effectTx(tx, run, prepared!)) return false;
      if (commitment !== undefined) voidPendingScopeTx(tx, commitment.scopeKey, now);
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: sealedAction,
        // Immutable after creation (04 §3.4.2); the parts and the scope key are M1-32's.
        scope_json: scope === undefined ? null : canonicalize(scope),
        answers_envelope_id: input.answersEnvelopeId ?? null,
        scope_key: commitment?.scopeKey ?? null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary: sealedSummary,
        status: 'pending',
        expires_at: expiresAt,
        created_at: now,
        decided_at: null,
      });
      if (commitment !== undefined) {
        insertCommitmentPartsTx(tx, approvalId, commitment.parts, now);
      }
      return true;
    });
    if (!written) {
      throw new CoreError('idempotency_lost', 'This call is already running elsewhere. Try again.');
    }
    if (run !== undefined) this.#idempotency.committed(run, prepared!);

    let url: string | undefined;
    try {
      const ticket = await this.#channel.request({
        approvalId,
        actionDigest,
        summary: input.summary,
        expiresAt,
      });
      url = ticket.url;
    } catch {
      // The row stands: the owner still sees it in the CLI or the local UI (fixed code, I-5).
      this.#ctx.log.warn('approval channel unavailable', { code: 'channel_error' });
    }
    return {
      status: 'pending_approval',
      approvalId,
      actionDigest,
      summary: input.summary,
      expiresAt,
      ...(url === undefined ? {} : { url }),
    };
  }

  /**
   * Whether `approvalId` lets this exact `action` proceed now. `decision` is policy evaluated again
   * at use (04 §3.4.1): a rule now `deny` refuses the call and leaves the approval unused.
   */
  async authorize(
    approvalId: string,
    action: unknown,
    decision: PolicyDecision,
  ): Promise<ApprovalAuthorization> {
    if (!approvalIdSchema.safeParse(approvalId).success) {
      return { status: 'refused', reason: 'approval_unknown' };
    }
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    if (row === undefined) return { status: 'refused', reason: 'approval_unknown' };
    // Commitments proceed per part of their scope (04 §3.4.2; M1-32), never as one use.
    if (row.scope_json !== null) return { status: 'refused', reason: 'commitment_scope' };
    const refusal = refusalOf(await this.#owner.checkApproval(approvalId, action));
    if (refusal !== undefined) return refusal;
    if (decision === 'deny') return { status: 'refused', reason: 'policy_deny' };
    const decided = row.signed_decision;
    return {
      status: 'authorized',
      claim: (tx: StoreTx): boolean =>
        tx.update(
          'approvals',
          {
            approval_id: approvalId,
            status: 'approved',
            scope_json: null,
            signed_decision: decided,
            signed_cancel: null,
            expires_at: { gte: nowOf(this.#ctx) },
          },
          { status: 'void' },
        ) === 1,
    };
  }

  /** authorize() and the claim in a transaction of its own, for a call with no other store effect. */
  async use(approvalId: string, action: unknown, decision: PolicyDecision): Promise<ApprovalUse> {
    const auth = await this.authorize(approvalId, action, decision);
    if (auth.status !== 'authorized') return auth;
    if (await this.#ctx.store.transaction((tx) => auth.claim(tx))) return { status: 'used' };
    // Used, cancelled, edited or lapsed between the check and the claim.
    return refusalOf(await this.#owner.checkApproval(approvalId, action)) ?? { status: 'void' };
  }

  /**
   * Asks the channel what it holds for `approvalId` and hands a signed object for it to
   * OwnerActions.apply, which verifies and applies it (I-4). A signed object for another request is
   * not applied from here.
   */
  async collect(approvalId: string): Promise<CollectOutcome> {
    let held: Awaited<ReturnType<ApprovalChannel['status']>>;
    try {
      held = await this.#channel.status(approvalId);
    } catch {
      this.#ctx.log.warn('approval channel unavailable', { code: 'channel_error' });
      return { status: 'unknown' };
    }
    if (held.state === 'pending') return { status: 'pending' };
    if (held.state !== 'signed' || typeof held.signed !== 'string') return { status: 'unknown' };
    let named: ReturnType<typeof namesApproval>;
    try {
      named = namesApproval(parseOwnerActionText(held.signed), approvalId);
    } catch {
      named = null;
    }
    // Anything that does not parse goes to apply, which refuses it as malformed and reports it.
    if (named !== null && !named.names) {
      return { status: 'refused', op: named.op, reason: 'other_request', nonceBurnt: false };
    }
    return this.#owner.apply(held.signed);
  }

  /**
   * Reads one approval by ID for its own stored action (06 §2.5; M1-7e-3). The sealed action is
   * opened and parsed under the strict schema, and OwnerActions.readApproval re-verifies the stored
   * signed objects against its recomputed digest. Read-only: it never applies, claims or changes a
   * row, and it never asks the channel (no `collect`: a `signed` result would be applied twice).
   */
  async read(approvalId: string): Promise<ApprovalState> {
    const notFound = { status: 'unknown', reason: 'not_found' } as const;
    const invalid = { status: 'unknown', reason: 'invalid' } as const;
    if (!approvalIdSchema.safeParse(approvalId).success) return notFound;
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    if (row === undefined) return notFound;
    let action: unknown;
    try {
      const text = await open(this.#ctx, 'approvals', 'action_json', [approvalId], row.action_json);
      action = parseJson(text);
    } catch {
      return invalid;
    }
    if (!approvalActionSchema.safeParse(action).success) return invalid;
    const reading = await this.#owner.readApproval(approvalId, action);
    if (reading.status === 'refused') {
      return reading.reason === 'approval_unknown' ? notFound : invalid;
    }
    // The row read again by readApproval may differ from `row` only in its mutable columns.
    const decided = reading.status !== 'pending' && reading.status !== 'void';
    return {
      status: reading.status,
      actionDigest: computeActionDigest(action),
      expiresAt: row.expires_at,
      ...(decided && row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    };
  }

  /**
   * What one approval is for, while the agent still has something to run (06 §2.5; M1-22): the row
   * reads `pending` or `approved` after the same re-verification as read(), and for a commitment its
   * answer is not sent yet (an `envelope` part unclaimed or claimed, or, with no `envelope` part, an
   * unclaimed `receipt` part). Undefined otherwise, and for any row that does not open, parse or
   * verify (fail closed). Read-only, and it authorises nothing (I-4).
   */
  async resumeOf(approvalId: string): Promise<ApprovalResume | undefined> {
    if (!approvalIdSchema.safeParse(approvalId).success) return undefined;
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    if (row === undefined) return undefined;
    let stored: unknown;
    try {
      const text = await open(this.#ctx, 'approvals', 'action_json', [approvalId], row.action_json);
      stored = parseJson(text);
    } catch {
      return undefined;
    }
    const parsed = approvalActionSchema.safeParse(stored);
    if (!parsed.success) return undefined;
    const reading = await this.#owner.readApproval(approvalId, stored);
    if (reading.status !== 'pending' && reading.status !== 'approved') return undefined;
    const action = parsed.data;
    if (commitmentScopeOf(action) !== undefined) {
      const parts = await this.#ctx.store.transaction((tx) =>
        tx.select('commitment_parts', { approval_id: approvalId }),
      );
      const envelope = parts.find((p) => p.part === 'envelope');
      const unrun =
        envelope !== undefined
          ? envelope.state === 'unclaimed' || envelope.state === 'claimed'
          : parts.some((p) => p.part === 'receipt' && p.state === 'unclaimed');
      if (!unrun) return undefined;
    }
    if (action.tool === 'agentlink_respond_to_terms') {
      const { envelopeId, decision, notarize } = action.args;
      if ((decision === 'accept' || decision === 'reject') && notarize === false) {
        return { tool: action.tool, envelopeId, decision };
      }
    }
    return { tool: action.tool };
  }

  /**
   * The open request for this exact `action`, so a tool called again without `approvalId` can hand
   * back the request it already made instead of asking the owner twice (06 §2.5; M1-13a follow-up).
   * Matches by the action digest, which binds the whole action; a commitment (scope) or an action
   * the strict schema refuses never matches. Each candidate's stored action is opened and its
   * signed objects re-verified (OwnerActions.readApproval): only `pending` or `approved` (unused,
   * unlapsed) is returned, an approved one before a pending one, newest first. A row that does not
   * open or verify is skipped (fail closed). Read-only: it never decides, claims or changes a row,
   * and an `approved` answer authorises nothing by itself; the call must still name the ID (I-4).
   */
  async findOpen(action: unknown): Promise<OpenApproval | undefined> {
    if (!approvalActionSchema.safeParse(action).success) return undefined;
    if (commitmentScopeOf(action) !== undefined) return undefined;
    const digest = computeActionDigest(action);
    const now = nowOf(this.#ctx);
    const candidates = await this.#ctx.store.transaction((tx) =>
      tx.select(
        'approvals',
        {
          status: { in: ['pending', 'approved'] },
          scope_json: null,
          signed_cancel: null,
          expires_at: { gte: now },
        },
        { orderBy: [['created_at', 'desc']], limit: MAX_OPEN_SCAN },
      ),
    );
    let pending: OpenApproval | undefined;
    for (const row of candidates) {
      let stored: unknown;
      try {
        const text = await open(
          this.#ctx,
          'approvals',
          'action_json',
          [row.approval_id],
          row.action_json,
        );
        stored = parseJson(text);
      } catch {
        continue;
      }
      if (!approvalActionSchema.safeParse(stored).success) continue;
      if (computeActionDigest(stored) !== digest) continue;
      const reading = await this.#owner.readApproval(row.approval_id, stored);
      if (reading.status === 'approved') {
        return { approvalId: row.approval_id, status: 'approved', expiresAt: row.expires_at };
      }
      if (reading.status === 'pending' && pending === undefined) {
        pending = { approvalId: row.approval_id, status: 'pending', expiresAt: row.expires_at };
      }
    }
    return pending;
  }

  /**
   * The number of approvals waiting for the owner (06 §2.1 `agentlink_status.pendingApprovals`):
   * undecided, not cancelled, not voided and not lapsed at the current time. A display count only;
   * it authorises nothing.
   */
  async countPending(): Promise<number> {
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction((tx) =>
      tx.count('approvals', {
        status: 'pending',
        signed_decision: null,
        signed_cancel: null,
        expires_at: { gte: now },
      }),
    );
  }

  /**
   * Marks lapsed rows `expired` (a cache: checkApproval derives expiry from the time anyway). A
   * commitment's approved scope is left to its parts (M1-32). Returns the number of rows changed.
   */
  async expireDue(): Promise<number> {
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction(
      (tx) =>
        tx.update(
          'approvals',
          { status: 'pending', expires_at: { lt: now } },
          { status: 'expired' },
        ) +
        tx.update(
          'approvals',
          { status: 'approved', scope_json: null, expires_at: { lt: now } },
          { status: 'expired' },
        ),
    );
  }
}
