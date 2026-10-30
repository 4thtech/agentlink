// Applying owner actions and loading the signed policy (04 §2.5.1, §2.5.2; 06 §3 G-6; 07 §3.4).
//
// - apply(): verifies a SignedOwnerAction (owner-action.ts) against the own card and the stored
//   requests, then checks the nonce, records it and applies the effect in ONE store transaction, so
//   two deliveries of one object apply it once. Everything the transaction writes is prepared
//   before it (sealed values, recomputed digests); inside it, the rows read before are compared with
//   what is there now, and a change refuses the object. A batch is applied whole or not at all; a
//   batch that is authentic and fresh but does not match burns its nonce in the same transaction,
//   so it can never apply later (04 §2.5.2). A refused single op writes nothing (07 §3.4). A
//   `contact.check` is routed to ContactBook.applyContactCheck (M1-7c-b), which recomputes the
//   pairing digest from the stored pair; `agent.revoke` is applied by M1-7h. `contact.rename` and
//   `contact.remove` (M1-9za) change one stored contact: the owner alias (06 §2.1 rule 1), or the
//   07 §3 tombstone. The nonce row is their audit record; nothing is sent to the contact.
//   `storage.set` and `storage.remove` (M1-9i-a, D-115) replace or delete the one `own_storage` row
//   with the nonce row in one transaction, then set the KeyStore `storage-mark`; `backup.export`
//   records its nonce row only (the audit record of a recovery kit export).
// - loadPolicy(): the G-6 loader. The stored `policy.set` is re-verified on every load and its
//   version must equal the KeyStore high-water mark; the defaults are used only while the mark is 0
//   and no row exists. Anything else fails closed (policy-engine.ts).
// - checkApproval(): re-verifies the stored decision for one `approvalId` and recomputes the digest
//   from the current call when the approval is used; `status` is only a cache (04 §2.5.1).
//
// I-4: authority comes only from the owner signature over the exact object. This module holds no
// owner key, takes no presence and has no path that decides, widens or creates an approval or a
// policy without one. Refusals are returned to the surface that delivered the object (the CLI or
// the local UI shows them; the console path is M1-7e/M1-7h) and logged as fixed codes (I-5, I-7).
import {
  canonicalize,
  decodeHex0x,
  encodeHex,
  parseJson,
  type JsonObject,
} from '@4thtech-io/crypto';
import {
  agentLabelParamsSchema,
  appChangeParamsSchema,
  approvalIdSchema,
  contactRenameParamsSchema,
  evmAddress,
  policyPatchSchema,
  policySchema,
  signedOwnerActionSchema,
  type OwnerActionOp,
  type Policy,
  type SignedOwnerAction,
} from '@4thtech-io/types';
import { isCommitmentAction } from './commitments.js';
import { isPaidPendingAction } from './pay-confirm.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import type { ContactBook } from './contacts.js';
import type { IdentityService } from './identity.js';
import { isRestrictedAlias } from './names.js';
import { credentialDigestsEqual, readStorageMark, type OwnStorageKeys } from './own-storage.js';
import {
  computeActionDigest,
  ownerActionHash,
  parseOwnerActionText,
  verifyOwnerAction,
  verifyStoredOwnerAction,
  type ApprovalRequestView,
  type ItemRefusalReport,
  type OwnerActionCheckContext,
  type OwnerActionRefusal,
  type OwnerActionVerdict,
} from './owner-action.js';
import {
  PREPARED_OWNER_ACTION_LIFETIME_SECONDS,
  buildOwnerActionBody,
  mergePolicyPatch,
  newOwnerActionNonce,
  policyEditWarnings,
  type OwnerActionBodyInput,
  type PolicyEditOptions,
  type PreparableOp,
  type PreparedOwnerAction,
  type PreparedPolicyEdit,
  type PrepareRefusal,
} from './owner-prepare.js';
import {
  POLICY_DEFAULTS_EFFECTIVE,
  type EffectivePolicy,
  type PolicyProblem,
} from './policy-engine.js';
import { SINGLETON_SLOT, type Row, type Sealed } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/**
 * The policy-version high-water mark (04 §2.5.1, §2.2, §2.8): a KeyStore item, not a store row, so
 * deleting or rolling back the store cannot lower it. Backends implement it next to their KeyStore
 * (keychain and file, Node); the Durable Object's place is fixed in M2-3a. Contract: `read` returns
 * the highest applied version (0 when none was ever applied) or throws; `raise` sets the mark to
 * max(mark, version) under the inter-process lock (06 §6), never lowers it, and returns the new mark.
 */
export interface PolicyVersionMark {
  read(): Promise<number>;
  raise(version: number): Promise<number>;
}

/**
 * The receipts-kept marker (04 §2.2; 06 §3 "Existing policies"; D-109, decided by Tali in chat on
 * 2026-10-20; M1-33a): a KeyStore item holding the `policy.set` version at which the owner explicitly
 * kept `receipts.autoDelivered: true`, or null when there is none. Not secret and grants nothing: it
 * only records that the owner already answered. `read` throws on a malformed item (read as not
 * kept); `write` replaces the item and rejects when the write did not stick.
 */
export interface ReceiptsKeptMark {
  read(): Promise<number | null>;
  write(version: number): Promise<void>;
}

/** The `local_owner_actions` record of the agent's label (U3-d; 07 §3.4). */
export const LABEL_RECORD = 'agent.label';

/** The agent's label as loaded (U3-d): only a `verified` label is ever shown. */
export type LabelReading =
  | { readonly status: 'verified'; readonly label: string }
  | { readonly status: 'none' }
  | { readonly status: 'unverified' };

export type OwnerActionOutcome =
  | {
      readonly status: 'applied';
      readonly op: OwnerActionOp;
      /** policy.set: the applied version and whether the KeyStore mark was raised to it. */
      readonly policyVersion?: number;
      readonly markRaised?: boolean;
      /**
       * storage.set and storage.remove (M1-9i-a): whether `storage-mark` was set to the new active
       * id (or null) and read back. False: own storage reads `broken` until the owner connects again.
       */
      readonly storageMarkSet?: boolean;
    }
  | {
      readonly status: 'refused';
      readonly op: string | null;
      readonly reason: OwnerActionRefusal;
      /** approval.decideBatch: every item that did not match its pending request. */
      readonly items?: readonly ItemRefusalReport[];
      /** True when the refused object's nonce was recorded, so it can never apply later. */
      readonly nonceBurnt: boolean;
    };

/** What `agentlink policy recover` may show and sign (D-100; OwnerActions.policyRecovery). */
export type PolicyRecovery =
  | { readonly status: 'valid' }
  | { readonly status: 'unavailable'; readonly problem: PolicyProblem }
  | {
      readonly status: 'fail_closed';
      readonly problem: PolicyProblem;
      /** The version a recovering `policy.set` signs: above the mark and the stored row. */
      readonly nextVersion: number;
      /** Only for `rolled_back` and `mark_mismatch`: the stored policy, its signature verified. */
      readonly stored?: { readonly policy: Policy; readonly version: number };
    };

/** What a stored approval allows when its `approvalId` is presented with a call (04 §2.5.1). */
export type ApprovalCheck =
  | { readonly status: 'approved' | 'denied' | 'pending' | 'expired' | 'cancelled' | 'void' }
  | {
      readonly status: 'refused';
      readonly reason:
        'approval_unknown' | 'digest_mismatch' | 'decision_invalid' | 'cancel_invalid';
    };

/**
 * What a stored approval says when it is read for its own stored action (06 §2.5
 * `agentlink_get_approval`; M1-7e-3). Like ApprovalCheck, but the signed objects are verified
 * before the `status` cache is read, so a use (`void` after an approve decision that verifies) is
 * told apart from a request voided before any decision. Read-only; it authorises nothing.
 */
export type ApprovalReading =
  | {
      readonly status:
        'approved' | 'denied' | 'pending' | 'expired' | 'cancelled' | 'used' | 'void';
    }
  | ApprovalCheckRefusal;

type ApprovalCheckRefusal = Extract<ApprovalCheck, { status: 'refused' }>;

type Refused = Extract<OwnerActionOutcome, { status: 'refused' }>;

type SelfView =
  | { readonly agent: string; readonly ownerNostr: string }
  | { readonly refusal: 'identity_missing' | 'identity_revoked' };

const refused = (
  op: string | null,
  reason: OwnerActionRefusal,
  extra: { items?: readonly ItemRefusalReport[]; nonceBurnt?: boolean } = {},
): Refused => ({
  status: 'refused',
  op,
  reason,
  ...(extra.items === undefined ? {} : { items: extra.items }),
  nonceBurnt: extra.nonceBurnt ?? false,
});

/** A shown name folded for comparison (as tool `Contact` resolution compares, 06 §2). */
const foldName = (name: string): string => name.normalize('NFKC').toLowerCase();

/** The other active contacts' name columns, as one comparable string (M1-9za alias uniqueness). */
const activeOthers = (tx: StoreTx, contactId: string): string =>
  JSON.stringify(
    tx
      .select('contacts', { status: 'active' })
      .filter((r) => r.contact_id !== contactId)
      .map((r) => [r.contact_id, r.name, r.name_source, r.updated_at])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  );

const fromVerdict = (v: Extract<OwnerActionVerdict, { ok: false }>): Refused =>
  refused(v.op, v.reason, v.items === undefined ? {} : { items: v.items });

/** A request row as read before the transaction, to compare inside it. */
interface Snapshot {
  readonly status: Row<'approvals'>['status'];
  readonly actionJson: Sealed;
  readonly expiresAt: number;
  /** The commitment scope decides whether the row may be a batch item (IR-M1-7d-1 F-5). */
  readonly scopeJson: string | null;
}

const unchanged = (row: Row<'approvals'> | undefined, snap: Snapshot): boolean =>
  row !== undefined &&
  row.status === snap.status &&
  row.action_json === snap.actionJson &&
  row.expires_at === snap.expiresAt &&
  row.scope_json === snap.scopeJson;

const nonceRow = (signed: SignedOwnerAction, actionHash: string, now: number) => ({
  nonce: signed.body.nonce,
  op: signed.body.op,
  action_hash: actionHash,
  issued_at: signed.body.issuedAt,
  expires_at: signed.body.expiresAt,
  applied_at: now,
});

/** 07 §3.5: the next applied policy.set starts a fresh ledger when the ledger is broken or gone. */
function freshLedgerIfBroken(tx: StoreTx, now: number): void {
  const state = tx.select('budget_state')[0];
  if (state !== undefined && state.status !== 'broken') return;
  const fresh = { status: 'ok' as const, newest_t: now, since: now, broken_at: null };
  if (state !== undefined) {
    tx.update(
      'budget_state',
      { slot: SINGLETON_SLOT },
      { ...fresh, ledger_epoch: state.ledger_epoch + 1 },
    );
    return;
  }
  const epochs = tx.select('budget_ledger').map((r) => r.ledger_epoch);
  tx.insert('budget_state', {
    slot: SINGLETON_SLOT,
    ledger_epoch: (epochs.length === 0 ? 0 : Math.max(...epochs)) + 1,
    ...fresh,
  });
}

export class OwnerActions {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;
  readonly #mark: PolicyVersionMark | undefined;
  readonly #receiptsKept: ReceiptsKeptMark | undefined;
  readonly #ownStorageKeys: OwnStorageKeys | undefined;

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    contacts: ContactBook,
    mark?: PolicyVersionMark,
    receiptsKept?: ReceiptsKeptMark,
    ownStorageKeys?: OwnStorageKeys,
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
    this.#mark = mark;
    this.#receiptsKept = receiptsKept;
    this.#ownStorageKeys = ownStorageKeys;
  }

  /** The own agent and its card's owner key, or why owner actions cannot apply. */
  async #self(): Promise<SelfView> {
    const view = await this.#identity.get();
    if (view === undefined) return { refusal: 'identity_missing' };
    if (view.revoked) return { refusal: 'identity_revoked' };
    return { agent: view.agentId, ownerNostr: view.card.ownerNostr };
  }

  #report(outcome: Refused): Refused {
    // Fixed codes only: never the object, a nonce or any input text (I-5, I-7).
    this.#ctx.log.warn('owner action refused', {
      op: outcome.op ?? 'unknown',
      reason: outcome.reason,
      nonceBurnt: outcome.nonceBurnt,
    });
    return outcome;
  }

  /**
   * Verifies and applies one SignedOwnerAction: its exact JSON text, or the object (stored as its
   * JCS text). Never throws for a refusal: the outcome says why, and is what the owner surface
   * reports (04 §2.5.1 "Refusals are reported"). Store errors still throw (fail closed).
   */
  async apply(input: string | object): Promise<OwnerActionOutcome> {
    let text: string;
    let value: unknown;
    try {
      text = typeof input === 'string' ? input : canonicalize(input);
      value = parseOwnerActionText(text);
    } catch {
      return this.#report(refused(null, 'malformed'));
    }
    const shape = signedOwnerActionSchema.safeParse(value);
    if (!shape.success) return this.#report(refused(null, 'malformed'));
    const op = shape.data.body.op;

    const self = await this.#self();
    if ('refusal' in self) return this.#report(refused(op, self.refusal));
    const now = nowOf(this.#ctx);
    const base: OwnerActionCheckContext = { ...self, now };

    switch (op) {
      case 'approval.decide':
      case 'approval.decideBatch':
        return this.#applyDecision(text, value, shape.data, base);
      case 'approval.cancel':
        return this.#applyCancel(text, value, base);
      case 'policy.set':
        return this.#applyPolicy(text, value, base);
      case 'contact.check':
        return this.#applyContactCheck(value);
      case 'contact.rename':
      case 'contact.remove':
        return this.#applyContactChange(value, base);
      case 'storage.set':
      case 'storage.remove':
        return this.#applyStorage(text, value, base);
      case 'backup.export':
        return this.#applyBackupExport(value, base);
      case 'agent.label':
        return this.#applyLabel(value, base);
      case 'app.connect':
      case 'app.disconnect':
        return this.#applyAppChange(value, base);
      case 'credits.deposit':
      case 'credits.withdraw':
      case 'agent.revoke': {
        // Verified for the report, applied elsewhere: revocation delivery is M1-7h; the credits ops
        // only through ProofService.addReceivedFunds and withdrawCredits (M1-11c-a4c), which check
        // the chain before anything is sent. Nothing is written here, so the nonce stays unused.
        const verdict = verifyOwnerAction(value, base);
        if (!verdict.ok && verdict.stage === 'object') return this.#report(fromVerdict(verdict));
        return this.#report(refused(op, 'unsupported_op'));
      }
    }
  }

  /**
   * `contact.check` (04 §2.5.1, §3.6.1; G-28): M1-7c-b's verify-and-store path, after the identity
   * checks above (`identity_revoked` included). It runs the same object checks in the same order, then
   * the nonce, then the op's rule (`pairingDigest` against the digest recomputed from the stored
   * signed `handshake` and `handshake-ack`), and checks and records the nonce and writes
   * `contacts.safety_check` in one store transaction. A refusal writes nothing. Its codes are
   * OwnerActionRefusal codes, reported unchanged; the contact book has already logged the code.
   */
  async #applyContactCheck(value: unknown): Promise<OwnerActionOutcome> {
    const outcome = await this.#contacts.applyContactCheck(value);
    if (outcome.status === 'refused') return refused('contact.check', outcome.reason);
    return { status: 'applied', op: 'contact.check' };
  }

  /**
   * `contact.rename` and `contact.remove` (M1-9za; 04 §2.5.1; 06 §2.1 rule 1; 07 §3; 02 F-14). The
   * object checks and the nonce first. Then the op's rule: the alias must already be its own
   * restricted form (`isRestrictedAlias`) and must not be the shown name of another active contact
   * (compared after NFKC and case folding, so a rename never makes a name ambiguous; the other
   * contacts' rows are compared again inside the transaction), and the contact must be stored and
   * not removed (a revoked
   * contact is never removed: removing never changes `revoked`, 07 §3). In one store transaction the
   * nonce is checked again and recorded (the audit row: op, action hash, applied time) and the
   * contact row is written: the sealed alias with `name_source` `owner`, or status `removed`, which
   * keeps the keys so later envelopes from them are dropped. A refusal writes nothing. Nothing is
   * sent to the contact.
   */
  async #applyContactChange(
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    const { body } = signed;
    if (body.op !== 'contact.rename' && body.op !== 'contact.remove') {
      return this.#report(refused(body.op, 'malformed'));
    }
    const op = body.op;
    const contactId = body.params.contact;
    let sealedAlias: Sealed | undefined;
    let othersSnapshot = '';
    if (body.op === 'contact.rename') {
      if (!isRestrictedAlias(body.params.alias)) return this.#report(refused(op, 'alias_invalid'));
      const wanted = foldName(body.params.alias);
      const others = (await this.#contacts.list()).filter(
        (c) => c.id !== contactId && c.status === 'active',
      );
      if (others.some((c) => foldName(c.display.name) === wanted)) {
        return this.#report(refused(op, 'alias_taken'));
      }
      othersSnapshot = await this.#ctx.store.transaction((tx) => activeOthers(tx, contactId));
      sealedAlias = await seal(this.#ctx, 'contacts', 'name', [contactId], body.params.alias);
    }
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: body.nonce }) !== undefined) {
        return refused(op, 'nonce_used');
      }
      const row = tx.get('contacts', { contact_id: contactId });
      if (row === undefined || row.status === 'removed') return refused(op, 'contact_unknown');
      if (sealedAlias !== undefined) {
        // The uniqueness check above read these rows; any change since refuses the object.
        if (activeOthers(tx, contactId) !== othersSnapshot) return refused(op, 'store_changed');
        tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
        tx.update(
          'contacts',
          { contact_id: contactId, status: row.status },
          { name: sealedAlias, name_source: 'owner', updated_at: now },
        );
        return { status: 'applied', op };
      }
      if (
        row.status === 'revoked' ||
        tx.get('revoked_agents', { agent_evm: contactId }) !== undefined
      ) {
        return refused(op, 'contact_revoked');
      }
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      tx.update(
        'contacts',
        { contact_id: contactId, status: { in: ['active', 'blocked'] } },
        { status: 'removed', updated_at: now },
      );
      return { status: 'applied', op };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  /**
   * `agent.label` (U3-d, D-138; 04 §2.5.1; 07 §3.4 `local_owner_actions`; proposed, owner confirms at
   * merge). The object checks and the nonce first (L(op) = 600 s; the schema already refused a
   * `params.agent` that is not the body's `agent`, and the body's `agent` must be this agent). Then
   * the op's rule: the label must already be its own restricted form (06 §2.1), else
   * `label_invalid`, never normalised. In one store transaction the nonce is checked again and
   * recorded (the audit row) and the one label row is replaced with the sealed signed object, so the
   * latest applied label is the label. A refusal writes nothing. Nothing is sent to anyone: the label
   * is local only, and the caller writes `config.json` `label` only after this applied.
   */
  async #applyLabel(value: unknown, base: OwnerActionCheckContext): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    const { body } = signed;
    if (body.op !== 'agent.label' || body.params.agent !== base.agent) {
      return this.#report(refused(body.op, 'agent_mismatch'));
    }
    if (!isRestrictedAlias(body.params.label)) {
      return this.#report(refused('agent.label', 'label_invalid'));
    }
    const sealed = await seal(
      this.#ctx,
      'local_owner_actions',
      'signed_json',
      [LABEL_RECORD],
      canonicalize(value as JsonObject),
    );
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: body.nonce }) !== undefined) {
        return refused('agent.label', 'nonce_used');
      }
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      if (tx.get('local_owner_actions', { record: LABEL_RECORD }) !== undefined) {
        tx.delete('local_owner_actions', { record: LABEL_RECORD });
      }
      tx.insert('local_owner_actions', {
        record: LABEL_RECORD,
        op: 'agent.label',
        signed_json: sealed,
        applied_at: now,
      });
      return { status: 'applied', op: 'agent.label' };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  /**
   * `app.connect` and `app.disconnect` (U3-f; 04 §2.5.1, §2.5 "Writing AI app configs"; 08 §1):
   * the object checks and the nonce first (another owner, another agent in the body or in
   * `params.agent`, a replay, an expired object or one outliving 600 s is refused and writes
   * nothing; the app id and `changeId` form are the schema's). Then, in one store transaction, the
   * nonce is checked again and recorded and the signed object is stored as the record of the entry
   * the owner wrote for that app (`app:<app>`, the latest applied one). It grants nothing on load.
   * The recomputed `changeId` is the owner surface's check, made before this and before the write
   * (node local-ui/api/apps.ts): core cannot read AI app configs. No envelope carries these ops.
   */
  async #applyAppChange(
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    const { body } = signed;
    if (
      (body.op !== 'app.connect' && body.op !== 'app.disconnect') ||
      body.params.agent !== base.agent
    ) {
      return this.#report(refused(body.op, 'agent_mismatch'));
    }
    const op = body.op;
    const record = `app:${body.params.app}`;
    const sealed = await seal(
      this.#ctx,
      'local_owner_actions',
      'signed_json',
      [record],
      canonicalize(value as JsonObject),
    );
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: body.nonce }) !== undefined) {
        return refused(op, 'nonce_used');
      }
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      if (tx.get('local_owner_actions', { record }) !== undefined) {
        tx.delete('local_owner_actions', { record });
      }
      tx.insert('local_owner_actions', { record, op, signed_json: sealed, applied_at: now });
      return { status: 'applied', op };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  /**
   * The agent's label (U3-d; 04 §2.5.1 "Labels and AI app connections"): the stored `agent.label`,
   * re-verified on every load (encoding, `sig`, `agent` and `params.agent` against this agent,
   * `owner` against its card, the schema and the restricted-label rule; the 600 s lifetime is not
   * checked again). `none`: no label was ever applied. `unverified`: a row exists but does not verify
   * or cannot be read: the caller never shows it and shows the folder name instead (fail closed).
   * The label is plain text: callers show it as text only, never as markup.
   */
  async loadLabel(): Promise<LabelReading> {
    const self = await this.#self();
    if ('refusal' in self) return { status: 'unverified' };
    let text: string;
    try {
      const row = await this.#ctx.store.transaction((tx) =>
        tx.get('local_owner_actions', { record: LABEL_RECORD }),
      );
      if (row === undefined) return { status: 'none' };
      if (row.op !== 'agent.label') return { status: 'unverified' };
      text = await open(
        this.#ctx,
        'local_owner_actions',
        'signed_json',
        [LABEL_RECORD],
        row.signed_json,
      );
    } catch {
      return { status: 'unverified' };
    }
    const verified = verifyStoredOwnerAction(text, self);
    if (!verified.ok) return { status: 'unverified' };
    const { body } = verified.signed;
    if (
      body.op !== 'agent.label' ||
      body.params.agent !== self.agent ||
      !isRestrictedAlias(body.params.label)
    ) {
      return { status: 'unverified' };
    }
    return { status: 'verified', label: body.params.label };
  }

  /**
   * W4-ONE-TOUCH (D-140; 04 §2.8 "Failure in the middle"; proposed, owner confirms at merge): records
   * that the stored `app.connect` with `nonce` for `app` was never applied, because the AI app's
   * config entry could not be written after it was stored. Its `app:<id>` record is removed, so
   * nothing can infer a connection from it; its nonce row stays, so the signed object can never be
   * applied later. Only that exact object (op, app, nonce) is removed; anything else is left alone
   * and the answer is false. Connection state is read only from the config file's entry (08 §1).
   */
  async markAppNotApplied(app: string, nonce: string): Promise<boolean> {
    const record = `app:${app}`;
    try {
      const row = await this.#ctx.store.transaction((tx) =>
        tx.get('local_owner_actions', { record }),
      );
      if (row === undefined || row.op !== 'app.connect') return false;
      const text = await open(
        this.#ctx,
        'local_owner_actions',
        'signed_json',
        [record],
        row.signed_json,
      );
      const parsed = signedOwnerActionSchema.safeParse(JSON.parse(text));
      if (
        !parsed.success ||
        parsed.data.body.op !== 'app.connect' ||
        parsed.data.body.params.app !== app ||
        parsed.data.body.nonce !== nonce
      ) {
        return false;
      }
      return await this.#ctx.store.transaction((tx) => {
        if (tx.get('owner_action_nonces', { nonce }) === undefined) return false;
        const now = tx.get('local_owner_actions', { record });
        if (now === undefined || now.applied_at !== row.applied_at) return false;
        tx.delete('local_owner_actions', { record });
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * `storage.set` and `storage.remove` (M1-9i-a, D-115; 04 §2.5.1; 07 §3.4). The object checks and
   * the nonce first (L(op) = 600 s). `storage.set` then needs the KeyStore item `s3:<id>` with the
   * signed credentialDigest (compared in constant time); `storage.remove` needs `id` to be the stored
   * row's. In one store transaction the nonce is checked again and recorded, and the row is replaced
   * (the sealed signed object, verbatim) or deleted. After the commit `storage-mark` is set to the
   * new `id` (or null) and read back; the store always commits first, as for `policies`. A refusal
   * writes nothing. The KeyStore item `s3:<id>` itself is written and deleted by the owner surface
   * through StorageCredentialControl, never here, and no credential reaches the core (I-7).
   */
  async #applyStorage(
    text: string,
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const keys = this.#ownStorageKeys;
    if (keys === undefined) {
      return this.#report(refused(shaped.body.op, 'storage_keys_unavailable'));
    }
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    const { body } = signed;
    if (body.op !== 'storage.set' && body.op !== 'storage.remove') {
      return this.#report(refused(body.op, 'malformed'));
    }
    const op = body.op;
    const id = body.params.id;
    const now = base.now;

    let sealed: Sealed | undefined;
    if (body.op === 'storage.set') {
      let digest: string | null;
      try {
        digest = await keys.credentialDigest(id);
      } catch {
        return this.#report(refused(op, 'storage_keys_unavailable'));
      }
      if (digest === null) return this.#report(refused(op, 'credential_missing'));
      if (!credentialDigestsEqual(digest, body.params.credentialDigest)) {
        return this.#report(refused(op, 'credential_mismatch'));
      }
      sealed = await seal(this.#ctx, 'own_storage', 'signed_json', [id], text);
    }

    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: body.nonce }) !== undefined) {
        return refused(op, 'nonce_used');
      }
      if (sealed !== undefined) {
        tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
        // One own storage per agent in M1: a newer storage.set replaces the row.
        tx.delete('own_storage', {});
        tx.insert('own_storage', { id, signed_json: sealed, applied_at: now });
        return { status: 'applied', op };
      }
      const row = tx.select('own_storage')[0];
      if (row === undefined || row.id !== id) return refused(op, 'storage_not_active');
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      tx.delete('own_storage', { id });
      return { status: 'applied', op };
    });
    if (outcome.status === 'refused') return this.#report(outcome);

    const active = op === 'storage.set' ? id : null;
    let storageMarkSet: boolean;
    try {
      await keys.writeMark(active);
      const back = await readStorageMark(keys);
      storageMarkSet = typeof back !== 'string' && back.active === active;
    } catch {
      storageMarkSet = false;
    }
    if (!storageMarkSet) {
      // Fixed text only: no id, endpoint or bucket (I-7). Own storage now reads `broken`.
      this.#ctx.log.warn('storage mark not set', { op });
    }
    return { status: 'applied', op, storageMarkSet };
  }

  /**
   * `backup.export` (M1-9i-a, D-115; 04 §2.3.3, §2.5.1): the object checks and the nonce, then the
   * nonce row alone, in one store transaction. That row (op, action hash, applied time) is the audit
   * record of the export; the CLI asks the export control to seal the kit only after this applied.
   */
  async #applyBackupExport(
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    if (signed.body.op !== 'backup.export') {
      return this.#report(refused(signed.body.op, 'malformed'));
    }
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: signed.body.nonce }) !== undefined) {
        return refused('backup.export', 'nonce_used');
      }
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      return { status: 'applied', op: 'backup.export' };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  /**
   * M1-11c-a4c: the object checks of a `credits.deposit` or `credits.withdraw` (04 §2.5.1, in its
   * order: encoding and strict schema, agent, owner, signature, freshness, lifetime, nonce) against
   * the own card, for exactly the op `op`. Writes nothing: `consumeCredits` records the nonce once
   * the chain checks passed and before anything is sent. Refusals are fixed codes, logged as such.
   */
  async verifyCredits(
    input: unknown,
    op: 'credits.deposit' | 'credits.withdraw',
  ): Promise<
    | { readonly ok: true; readonly signed: SignedOwnerAction; readonly actionHash: string }
    | { readonly ok: false; readonly reason: OwnerActionRefusal }
  > {
    let value: unknown;
    try {
      value = parseOwnerActionText(canonicalize(input));
    } catch {
      return { ok: false, reason: this.#report(refused(null, 'malformed')).reason };
    }
    const shape = signedOwnerActionSchema.safeParse(value);
    if (!shape.success || shape.data.body.op !== op) {
      return { ok: false, reason: this.#report(refused(null, 'malformed')).reason };
    }
    const self = await this.#self();
    if ('refusal' in self)
      return { ok: false, reason: this.#report(refused(op, self.refusal)).reason };
    const usedBefore = await this.#nonceUsed(shape.data.body.nonce);
    const verdict = verifyOwnerAction(value, {
      ...self,
      now: nowOf(this.#ctx),
      nonceUsed: () => usedBefore,
    });
    if (!verdict.ok) return { ok: false, reason: this.#report(fromVerdict(verdict)).reason };
    return { ok: true, signed: verdict.signed, actionHash: verdict.actionHash };
  }

  /**
   * M1-11c-a4c: records a verified credits op's nonce (the audit row: op, action hash, applied time)
   * in one store transaction, so the object applies at most once. False when the nonce was recorded
   * in the meantime (nothing is written then).
   */
  async consumeCredits(signed: SignedOwnerAction, actionHash: string): Promise<boolean> {
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction((tx) => {
      if (tx.get('owner_action_nonces', { nonce: signed.body.nonce }) !== undefined) return false;
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      return true;
    });
  }

  async #nonceUsed(nonce: string): Promise<boolean> {
    return this.#ctx.store.transaction(
      (tx) => tx.get('owner_action_nonces', { nonce }) !== undefined,
    );
  }

  /** Reads and opens the named requests, recomputing each digest from the stored action. */
  async #requests(ids: readonly string[]) {
    const rows = await this.#ctx.store.transaction((tx) =>
      ids.map((approval_id) => tx.get('approvals', { approval_id })),
    );
    const views = new Map<string, ApprovalRequestView>();
    const snapshots = new Map<string, Snapshot>();
    for (const row of rows) {
      if (row === undefined) continue;
      snapshots.set(row.approval_id, {
        status: row.status,
        actionJson: row.action_json,
        expiresAt: row.expires_at,
        scopeJson: row.scope_json,
      });
      let actionDigest: string;
      let scoped = false;
      // 04 §2.5.3 rule 7: a request whose action carries a fee is never a batch item. An
      // unreadable action is treated as paid (fail closed; its digest cannot match anyway).
      let paid = true;
      try {
        const text = await open(
          this.#ctx,
          'approvals',
          'action_json',
          [row.approval_id],
          row.action_json,
        );
        const action = parseJson(text);
        actionDigest = computeActionDigest(action);
        // A scope, or `commitments.accept` among the triggers (an accepted/rejected acknowledgement
        // has no scope but is a commitment, D-31): never a batch item (D-68, M1-20).
        scoped = isCommitmentAction(action);
        paid = isPaidPendingAction(action);
      } catch {
        // An unreadable stored action can never match a signed digest (fail closed).
        actionDigest = '';
      }
      views.set(row.approval_id, {
        approvalId: row.approval_id,
        actionDigest,
        expiresAt: row.expires_at,
        commitment: row.scope_json !== null || scoped,
        paid,
        pending: row.status === 'pending',
      });
    }
    return { views, snapshots };
  }

  async #applyDecision(
    text: string,
    value: unknown,
    shaped: SignedOwnerAction,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const body = shaped.body;
    const ids =
      body.op === 'approval.decideBatch'
        ? body.params.items.map((i) => i.approvalId)
        : body.op === 'approval.decide'
          ? [body.params.approvalId]
          : [];
    const usedBefore = await this.#nonceUsed(body.nonce);
    const { views, snapshots } = await this.#requests(ids);
    const verdict = verifyOwnerAction(value, {
      ...base,
      nonceUsed: () => usedBefore,
      approvalRequest: (id) => views.get(id),
    });
    if (!verdict.ok && verdict.stage === 'object') return this.#report(fromVerdict(verdict));
    const isBatch = body.op === 'approval.decideBatch';
    // A single decision that does not match writes nothing; a batch burns its nonce (04 §2.5.2).
    if (!verdict.ok && !isBatch) return this.#report(fromVerdict(verdict));

    const signed = verdict.ok ? verdict.signed : (verdict.signed as SignedOwnerAction);
    const actionHash = verdict.ok ? verdict.actionHash : '';
    const decisions =
      signed.body.op === 'approval.decideBatch'
        ? signed.body.params.items
        : signed.body.op === 'approval.decide'
          ? [signed.body.params]
          : [];
    const now = base.now;
    const hash = actionHash === '' ? ownerActionHash(value) : actionHash;

    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: signed.body.nonce }) !== undefined) {
        return refused(signed.body.op, 'nonce_used');
      }
      const burn = (r: Refused): Refused => {
        tx.insert('owner_action_nonces', nonceRow(signed, hash, now));
        return { ...r, nonceBurnt: true };
      };
      if (!verdict.ok) return burn(fromVerdict(verdict));
      // The rows must be exactly what was verified: no decision, edit or expiry in between.
      const changed = decisions
        .filter((d) => {
          const snap = snapshots.get(d.approvalId);
          return (
            snap === undefined ||
            !unchanged(tx.get('approvals', { approval_id: d.approvalId }), snap)
          );
        })
        .map((d) => ({ approvalId: d.approvalId, reason: 'not_pending' as const }));
      if (changed.length > 0) {
        const r = refused(signed.body.op, 'store_changed', isBatch ? { items: changed } : {});
        return isBatch ? burn(r) : r;
      }
      tx.insert('owner_action_nonces', nonceRow(signed, hash, now));
      for (const d of decisions) {
        const n = tx.update(
          'approvals',
          { approval_id: d.approvalId, status: 'pending' },
          {
            status: d.decision === 'approve' ? 'approved' : 'denied',
            signed_decision: text,
            decided_at: now,
          },
        );
        // Checked above in this transaction; anything else is a store fault (rolls back).
        if (n !== 1) throw new Error('approval row changed inside the transaction');
      }
      return { status: 'applied', op: signed.body.op as OwnerActionOp };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  async #applyCancel(
    text: string,
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    const shaped = signedOwnerActionSchema.parse(value);
    const usedBefore = await this.#nonceUsed(shaped.body.nonce);
    const verdict = verifyOwnerAction(value, { ...base, nonceUsed: () => usedBefore });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    if (signed.body.op !== 'approval.cancel')
      return this.#report(refused(signed.body.op, 'malformed'));
    const approvalId = signed.body.params.approvalId;
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: signed.body.nonce }) !== undefined) {
        return refused('approval.cancel', 'nonce_used');
      }
      const row = tx.get('approvals', { approval_id: approvalId });
      if (row === undefined) return refused('approval.cancel', 'approval_unknown');
      // A pending request is denied instead (04 §2.5.1; IR-M1-7d-1 F-4): the cancel is its signed
      // object, so the row can never be approved by a later decision.
      if (row.status === 'pending') {
        tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
        tx.update(
          'approvals',
          { approval_id: approvalId, status: 'pending' },
          { status: 'denied', signed_cancel: text, decided_at: now },
        );
        return { status: 'applied', op: 'approval.cancel' };
      }
      // Otherwise cancel only voids an approved approval; anything else has nothing to void.
      if (row.status !== 'approved') return refused('approval.cancel', 'not_approved');
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      tx.update(
        'approvals',
        { approval_id: approvalId, status: 'approved' },
        { status: 'cancelled', signed_cancel: text },
      );
      // The unused parts of a commitment scope are void (04 §3.4.2; the scope rules are M1-32).
      tx.update(
        'commitment_parts',
        { approval_id: approvalId, state: 'unclaimed' },
        { state: 'void', void_reason: 'cancelled', updated_at: now },
      );
      return { status: 'applied', op: 'approval.cancel' };
    });
    return outcome.status === 'refused' ? this.#report(outcome) : outcome;
  }

  async #readMark(): Promise<number | undefined> {
    if (this.#mark === undefined) return undefined;
    try {
      const mark = await this.#mark.read();
      return Number.isSafeInteger(mark) && mark >= 0 ? mark : undefined;
    } catch {
      return undefined;
    }
  }

  async #applyPolicy(
    text: string,
    value: unknown,
    base: OwnerActionCheckContext,
  ): Promise<OwnerActionOutcome> {
    // 07 §3.4 "Apply": the KeyStore mark is read first. Without it the version rule cannot hold.
    const mark = await this.#readMark();
    if (mark === undefined) return this.#report(refused('policy.set', 'policy_mark_unavailable'));
    const shaped = signedOwnerActionSchema.parse(value);
    const { usedBefore, stored } = await this.#ctx.store.transaction((tx) => ({
      usedBefore: tx.get('owner_action_nonces', { nonce: shaped.body.nonce }) !== undefined,
      stored: tx.get('policies', { slot: SINGLETON_SLOT })?.version ?? 0,
    }));
    const verdict = verifyOwnerAction(value, {
      ...base,
      nonceUsed: () => usedBefore,
      appliedPolicyVersion: Math.max(mark, stored),
    });
    if (!verdict.ok) return this.#report(fromVerdict(verdict));
    const { signed, actionHash } = verdict;
    if (signed.body.op !== 'policy.set') return this.#report(refused(signed.body.op, 'malformed'));
    const version = signed.body.params.version;
    const key = [SINGLETON_SLOT];
    const sealedSigned = await seal(this.#ctx, 'policies', 'signed_json', key, text);
    const sealedHash = await seal(
      this.#ctx,
      'policies',
      'policy_hash',
      key,
      computeActionDigest(signed.body.params.policy),
    );
    const now = base.now;
    const outcome = await this.#ctx.store.transaction((tx): OwnerActionOutcome => {
      if (tx.get('owner_action_nonces', { nonce: signed.body.nonce }) !== undefined) {
        return refused('policy.set', 'nonce_used');
      }
      const row = tx.get('policies', { slot: SINGLETON_SLOT });
      if (row !== undefined && version <= row.version)
        return refused('policy.set', 'version_not_newer');
      tx.insert('owner_action_nonces', nonceRow(signed, actionHash, now));
      tx.delete('policies', {});
      tx.insert('policies', {
        slot: SINGLETON_SLOT,
        version,
        signed_json: sealedSigned,
        policy_hash: sealedHash,
        applied_at: now,
      });
      freshLedgerIfBroken(tx, now);
      return { status: 'applied', op: 'policy.set' };
    });
    if (outcome.status === 'refused') return this.#report(outcome);
    // The store commits first, then the mark is raised (07 §3.4, decided at #44). If raising fails,
    // the stored version and the mark differ and the load fails closed until a newer policy.set.
    let markRaised: boolean;
    try {
      markRaised = (await this.#mark!.raise(version)) >= version;
    } catch {
      markRaised = false;
    }
    if (!markRaised) {
      this.#ctx.log.warn('policy version mark not raised', { version });
    }
    // Echoing the signed object to the owner channel (04 §2.5.1) needs the transport (M1-7h).
    return { status: 'applied', op: 'policy.set', policyVersion: version, markRaised };
  }

  /**
   * The policy to evaluate with, re-verified now (G-6, 06 §3; 04 §2.5.1). Never the defaults once a
   * version has been applied or a row exists; a store error is a fail-closed result, not an empty
   * policy.
   */
  async loadPolicy(): Promise<EffectivePolicy> {
    return (await this.#inspectPolicy()).effective;
  }

  /**
   * 06 §3 "Existing policies" (D-109; M1-33a): true when delivery receipts are on from an older
   * default, so the next owner-signed `policy.set` must ask before keeping them. That is a policy
   * with global `receipts.autoDelivered: true` whose version the receipts-kept marker does not
   * cover (no marker, an unreadable one, or one above the version). Without `rules`, the loaded
   * policy: only a verified, signed one can be from an older default (the defaults have `false`,
   * and under fail closed no receipt is signed automatically). With `rules` (the stored policy that
   * `policy recover` reviews), that policy and version. Read-only.
   */
  async receiptsOnFromOlderDefault(rules?: {
    readonly policy: Policy;
    readonly version: number;
  }): Promise<boolean> {
    let checked = rules;
    if (checked === undefined) {
      const effective = await this.loadPolicy();
      if (effective.mode !== 'signed') return false;
      checked = { policy: effective.policy as Policy, version: effective.version };
    }
    if (checked.policy.receipts.autoDelivered !== true) return false;
    return !(await this.#keptAt(checked.version));
  }

  /**
   * Records that the owner kept delivery receipts on at `version` (06 §3, D-109; M1-33a). Only for
   * the verified, applied policy at exactly that version with `receipts.autoDelivered: true`, so a
   * call can never mark a policy the owner did not sign. False when refused, without a marker store,
   * or when the write failed; the owner is then asked again at the next `policy.set` (the private
   * side). Grants nothing (I-4): the policy itself already says `true`.
   */
  async recordReceiptsKept(version: number): Promise<boolean> {
    if (this.#receiptsKept === undefined) return false;
    const effective = await this.loadPolicy();
    if (
      effective.mode !== 'signed' ||
      effective.version !== version ||
      effective.policy.receipts.autoDelivered !== true
    ) {
      return false;
    }
    try {
      await this.#receiptsKept.write(version);
    } catch {
      return false;
    }
    return this.#keptAt(version);
  }

  /** True when the marker reads a version at most `version`; anything else is not kept. */
  async #keptAt(version: number): Promise<boolean> {
    if (this.#receiptsKept === undefined) return false;
    let kept: number | null;
    try {
      kept = await this.#receiptsKept.read();
    } catch {
      return false;
    }
    return typeof kept === 'number' && Number.isSafeInteger(kept) && kept >= 0 && kept <= version;
  }

  /**
   * What `agentlink policy recover` (D-100; 06 §3, §8) may show and sign. Read-only: it signs and
   * applies nothing; authority still comes only from a new owner-signed `policy.set` (I-4).
   * - `valid`: the policy loads (signed, or the defaults); there is nothing to recover.
   * - `unavailable`: the mark, the store or the own identity can't be read, so no version can be
   *   chosen and nothing can be recovered now.
   * - `fail_closed`: the kind of failure and the version a new `policy.set` needs: above the mark
   *   and above the stored row's version (apply refuses anything not newer than both). `stored` is
   *   the stored policy only when it parses and its signature verifies (`rolled_back`,
   *   `mark_mismatch`); otherwise the owner reviews the defaults.
   */
  async policyRecovery(): Promise<PolicyRecovery> {
    const inspected = await this.#inspectPolicy();
    const { effective } = inspected;
    if (effective.mode !== 'fail_closed') return { status: 'valid' };
    const { problem } = effective;
    if (
      inspected.mark === undefined ||
      inspected.rowVersion === undefined ||
      problem === 'identity_unavailable'
    ) {
      return { status: 'unavailable', problem };
    }
    const nextVersion = Math.max(inspected.mark, inspected.rowVersion) + 1;
    if (!Number.isSafeInteger(nextVersion)) return { status: 'unavailable', problem };
    const { verified } = inspected;
    if ((problem === 'rolled_back' || problem === 'mark_mismatch') && verified !== undefined) {
      return { status: 'fail_closed', problem, nextVersion, stored: verified };
    }
    return { status: 'fail_closed', problem, nextVersion };
  }

  // --- Prepare helpers for owner surfaces (M1-11r-b, D-118) ---------------------------------------
  //
  // Each builds the unsigned body the local UI server shows, signs after the owner's presence
  // (M1-11s-b) and passes to apply(). They sign nothing, write nothing and grant nothing (I-4); the
  // op's rule is checked here only so the owner is not asked to sign what apply() would refuse, and
  // apply() checks it again. Refusals are fixed codes (I-5, I-7). No MCP tool calls them.

  /** The agent and its card's owner key as `owner` spells it, or why nothing can be prepared. */
  async #signer(): Promise<
    { readonly agent: string; readonly owner: string } | { readonly refusal: PrepareRefusal }
  > {
    const self = await this.#self();
    if ('refusal' in self) return { refusal: self.refusal };
    return { agent: self.agent, owner: encodeHex(decodeHex0x(self.ownerNostr, { length: 32 })) };
  }

  #build<O extends PreparableOp>(
    signer: { readonly agent: string; readonly owner: string },
    op: O,
    params: OwnerActionBodyInput<O>['params'],
  ): Extract<PreparedOwnerAction, { status: 'prepared' }> {
    const issuedAt = nowOf(this.#ctx);
    const { body, jcs } = buildOwnerActionBody<O>({
      ...signer,
      op,
      params,
      nonce: newOwnerActionNonce(),
      issuedAt,
      expiresAt: issuedAt + PREPARED_OWNER_ACTION_LIFETIME_SECONDS,
    });
    return { status: 'prepared', op, body, jcs };
  }

  /**
   * The unsigned `policy.set` for an edit on the Rules or Files page (04 §2.5.1; 06 §3): the complete
   * document, built from the verified policy in force (or the 06 §3 defaults while none was ever
   * applied) with `patch` merged over it, at version max(KeyStore mark, stored row) + 1.
   *
   * Refused, building nothing, when: the patch is not a strict PolicyPatch or the merged document is
   * not a valid policy (`patch_invalid`: every 06 §3 bound holds, `allowKeyDisclosure` is never
   * `allow`, lists stay sorted and unique, nothing is normalised); the policy fails closed or its
   * mark is unreadable (`policy_not_valid`: no value is ever taken from an invalid policy, and the
   * way back is `policy recover`, D-100); `options.baseVersion` is not the version in force
   * (`stale_version`). Delivery receipts on from an older default (D-109) are signed `false` unless
   * `options.keepDeliveryReceipts` is `true` (a patch value is never the answer). Every loosening is
   * returned as a stable warning code the server makes the owner acknowledge. Two bodies prepared from one
   * base sign one version: apply() takes the first and refuses the second (`version_not_newer`).
   */
  async preparePolicyEdit(
    patch: unknown,
    options: PolicyEditOptions = {},
  ): Promise<PreparedPolicyEdit> {
    const refuse = (reason: PrepareRefusal) =>
      ({ status: 'refused', op: 'policy.set', reason }) as const;
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    const parsedPatch = policyPatchSchema.safeParse(patch);
    if (!parsedPatch.success) return refuse('patch_invalid');

    const inspected = await this.#inspectPolicy();
    const { effective } = inspected;
    if (
      effective.mode === 'fail_closed' ||
      inspected.mark === undefined ||
      inspected.rowVersion === undefined
    ) {
      return refuse('policy_not_valid');
    }
    const baseVersion = effective.mode === 'signed' ? effective.version : 0;
    if (options.baseVersion !== undefined && options.baseVersion !== baseVersion) {
      return refuse('stale_version');
    }
    const version = Math.max(inspected.mark, inspected.rowVersion) + 1;
    if (!Number.isSafeInteger(version)) return refuse('policy_not_valid');

    const base = policySchema.parse(effective.policy);
    const merged = mergePolicyPatch(base, parsedPatch.data);
    const askKeepDeliveryReceipts =
      effective.mode === 'signed' &&
      (await this.receiptsOnFromOlderDefault({ policy: base, version: baseVersion }));
    let keepDeliveryReceipts = false;
    if (askKeepDeliveryReceipts) {
      // D-109: only the owner's explicit answer keeps them. A patch value (a form re-submitting the
      // receipts section as shown) is never that answer (IR-M1-11r-b-1 L1).
      keepDeliveryReceipts = options.keepDeliveryReceipts === true;
      merged.receipts.autoDelivered = keepDeliveryReceipts;
    }
    const policy = policySchema.safeParse(merged);
    if (!policy.success) return refuse('patch_invalid');

    const built = this.#build(signer, 'policy.set', { version, policy: policy.data });
    return {
      ...built,
      version,
      baseVersion,
      askKeepDeliveryReceipts,
      keepDeliveryReceipts,
      warnings: policyEditWarnings(base, policy.data),
    };
  }

  /**
   * The unsigned `contact.check` for "They match" (04 §2.5.1, §3.6.1): `pairingDigest` is recomputed
   * now from the stored signed `handshake` and `handshake-ack`, as apply() recomputes it.
   */
  async prepareContactCheck(contactId: string): Promise<PreparedOwnerAction> {
    const refuse = (reason: PrepareRefusal) =>
      ({ status: 'refused', op: 'contact.check', reason }) as const;
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    if (!evmAddress.safeParse(contactId).success) return refuse('contact_unknown');
    const found = await this.#contacts.currentPairingDigest(contactId);
    if (found.status === 'unknown') return refuse('contact_unknown');
    if (found.status === 'unavailable') return refuse('pairing_unavailable');
    return this.#build(signer, 'contact.check', {
      contact: contactId,
      pairingDigest: found.pairingDigest,
    });
  }

  /**
   * The unsigned `contact.rename` (04 §2.5.1; 06 §2.1 rule 1): the alias must already be its own
   * restricted form and must not be another active contact's shown name (NFKC, case folded); the
   * contact must be stored and not removed. The same rules apply() checks.
   */
  async prepareContactRename(contactId: string, alias: string): Promise<PreparedOwnerAction> {
    const refuse = (reason: PrepareRefusal) =>
      ({ status: 'refused', op: 'contact.rename', reason }) as const;
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    if (!evmAddress.safeParse(contactId).success) return refuse('contact_unknown');
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('contacts', { contact_id: contactId }),
    );
    if (row === undefined || row.status === 'removed') return refuse('contact_unknown');
    if (
      !contactRenameParamsSchema.safeParse({ contact: contactId, alias }).success ||
      !isRestrictedAlias(alias)
    ) {
      return refuse('alias_invalid');
    }
    const wanted = foldName(alias);
    const others = (await this.#contacts.list()).filter(
      (c) => c.id !== contactId && c.status === 'active',
    );
    if (others.some((c) => foldName(c.display.name) === wanted)) return refuse('alias_taken');
    return this.#build(signer, 'contact.rename', { contact: contactId, alias });
  }

  /**
   * The unsigned `agent.label` for this agent (U3-d, D-138; 04 §2.5.1): `params.agent` is this
   * agent's `agentId`, never a value from the page. The label must be 1 to 32 code points already in
   * its own restricted form (06 §2.1), else `label_invalid`, as apply() refuses it. Writes nothing.
   */
  async prepareLabel(label: string): Promise<PreparedOwnerAction> {
    const refuse = (reason: PrepareRefusal) =>
      ({ status: 'refused', op: 'agent.label', reason }) as const;
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    if (
      !agentLabelParamsSchema.safeParse({ agent: signer.agent, label }).success ||
      !isRestrictedAlias(label)
    ) {
      return refuse('label_invalid');
    }
    return this.#build(signer, 'agent.label', { agent: signer.agent, label });
  }

  /**
   * The unsigned `app.connect` or `app.disconnect` for this agent (U3-f; 04 §2.5.1): `agent` and
   * `params.agent` are this agent's agentId; `app` must be an id of the fixed harness table and
   * `changeId` 64 lowercase hex, else `change_invalid`. Writes nothing; the owner surface recomputes
   * the change after the gesture and before the write.
   */
  async prepareAppChange(
    op: 'app.connect' | 'app.disconnect',
    app: string,
    changeId: string,
  ): Promise<PreparedOwnerAction> {
    const refuse = (reason: PrepareRefusal) => ({ status: 'refused', op, reason }) as const;
    if (op !== 'app.connect' && op !== 'app.disconnect') {
      return { status: 'refused', op: 'app.connect', reason: 'change_invalid' };
    }
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    const params = appChangeParamsSchema.safeParse({ app, agent: signer.agent, changeId });
    if (!params.success) return refuse('change_invalid');
    return this.#build(signer, op, { app: params.data.app, agent: signer.agent, changeId });
  }

  /**
   * The unsigned `contact.remove` (04 §2.5.1; 07 §3): refused for an unknown or removed contact and
   * for a revoked one (removing never changes `revoked`), as apply() refuses them.
   */
  async prepareContactRemove(contactId: string): Promise<PreparedOwnerAction> {
    const refuse = (reason: PrepareRefusal) =>
      ({ status: 'refused', op: 'contact.remove', reason }) as const;
    const signer = await this.#signer();
    if ('refusal' in signer) return refuse(signer.refusal);
    if (!evmAddress.safeParse(contactId).success) return refuse('contact_unknown');
    const state = await this.#ctx.store.transaction((tx) => {
      const row = tx.get('contacts', { contact_id: contactId });
      if (row === undefined || row.status === 'removed') return 'unknown' as const;
      if (
        row.status === 'revoked' ||
        tx.get('revoked_agents', { agent_evm: contactId }) !== undefined
      ) {
        return 'revoked' as const;
      }
      return 'ok' as const;
    });
    if (state === 'unknown') return refuse('contact_unknown');
    if (state === 'revoked') return refuse('contact_revoked');
    return this.#build(signer, 'contact.remove', { contact: contactId });
  }

  /**
   * The G-6 loader, with what recovery needs next to its result: the mark, the stored row's version
   * (0 without a row; absent when the store can't be read) and the stored policy when its signed
   * object verifies and the policy parses.
   */
  async #inspectPolicy(): Promise<{
    readonly effective: EffectivePolicy;
    readonly mark?: number;
    readonly rowVersion?: number;
    readonly verified?: { readonly policy: Policy; readonly version: number };
  }> {
    const failClosed = (problem: PolicyProblem) =>
      ({ effective: { mode: 'fail_closed', problem } }) as const;
    const mark = await this.#readMark();
    if (mark === undefined) return failClosed('mark_unavailable');
    let row: Row<'policies'> | undefined;
    let self: SelfView;
    try {
      row = await this.#ctx.store.transaction((tx) => tx.get('policies', { slot: SINGLETON_SLOT }));
    } catch {
      return { ...failClosed('unreadable'), mark };
    }
    if (row === undefined) {
      return mark === 0
        ? { effective: POLICY_DEFAULTS_EFFECTIVE, mark, rowVersion: 0 }
        : { ...failClosed('missing'), mark, rowVersion: 0 };
    }
    const at = { mark, rowVersion: row.version };

    let text: string;
    let hash: string;
    try {
      text = await open(this.#ctx, 'policies', 'signed_json', [SINGLETON_SLOT], row.signed_json);
      hash = await open(this.#ctx, 'policies', 'policy_hash', [SINGLETON_SLOT], row.policy_hash);
    } catch {
      return { ...failClosed('unreadable'), ...at };
    }
    try {
      self = await this.#self();
    } catch {
      return { ...failClosed('identity_unavailable'), ...at };
    }
    if ('refusal' in self) return { ...failClosed('identity_unavailable'), ...at };

    const verified = verifyStoredOwnerAction(text, self);
    if (!verified.ok) {
      switch (verified.reason) {
        case 'agent_mismatch':
        case 'owner_mismatch':
        case 'signature_invalid':
          return { ...failClosed(verified.reason), ...at };
        default:
          return { ...failClosed('invalid'), ...at };
      }
    }
    const { body } = verified.signed;
    if (body.op !== 'policy.set') return { ...failClosed('invalid'), ...at };
    // Belt and braces: the strict schema already checked it as part of the object.
    const parsed = policySchema.safeParse(body.params.policy);
    if (!parsed.success) return { ...failClosed('invalid'), ...at };
    const version = body.params.version;
    const stored = { ...at, verified: { policy: parsed.data, version } };
    if (version < mark) return { ...failClosed('rolled_back'), ...stored };
    if (version !== mark) return { ...failClosed('mark_mismatch'), ...stored };
    // Columns derived from the signed object are caches; one that disagrees is a tampered row.
    if (row.version !== version || hash !== computeActionDigest(body.params.policy)) {
      return { ...failClosed('tampered'), ...stored };
    }
    return { effective: { mode: 'signed', policy: body.params.policy, version }, ...stored };
  }

  /**
   * What the stored approval allows for `approvalId` and this call's action (04 §2.5.1): the stored
   * decision (an `approval.decide`, or the batch with exactly one item for this ID) and any cancel
   * are re-verified, and the digest is recomputed from `action`. The `status` column is not read
   * as authority. Freshness and the nonce are not checked again (they applied once).
   */
  async checkApproval(approvalId: string, action: unknown): Promise<ApprovalCheck> {
    const loaded = await this.#loadApproval(approvalId);
    if ('status' in loaded) return loaded;
    const { row, self } = loaded;
    const now = nowOf(this.#ctx);

    if (row.signed_cancel !== null) {
      if (!cancelVerifies(row.signed_cancel, self, approvalId)) {
        return { status: 'refused', reason: 'cancel_invalid' };
      }
      // A cancel of a request that was never decided denied it (04 §2.5.1).
      return row.signed_decision === null ? { status: 'denied' } : { status: 'cancelled' };
    }
    // A status only ever takes authority away, never grants it (04 §2.5.1): a used approval
    // (`void`, M1-7e) or a lapsed one stays so, whatever its signed decision says.
    if (row.status === 'void' || row.status === 'expired') return { status: row.status };
    if (row.signed_decision === null) {
      return now > row.expires_at ? { status: 'expired' } : { status: 'pending' };
    }
    const decision = storedDecision(row.signed_decision, self, approvalId, action);
    if (typeof decision !== 'string') return decision;
    if (decision === 'deny') return { status: 'denied' };
    return now > row.expires_at ? { status: 'expired' } : { status: 'approved' };
  }

  /**
   * What the stored approval says for `approvalId`, read for `action`, the row's own stored action
   * (06 §2.5 `agentlink_get_approval`; M1-7e-3). The stored cancel and decision are re-verified
   * first; only then is the `status` cache read, and only to take authority away. `used` is a
   * `void` row whose approve decision verifies for this action and that is not a commitment (whose
   * parts are used one by one, M1-32). Never writes and never claims.
   */
  async readApproval(approvalId: string, action: unknown): Promise<ApprovalReading> {
    const loaded = await this.#loadApproval(approvalId);
    if ('status' in loaded) return loaded;
    const { row, self } = loaded;
    const lapsed = row.status === 'expired' || nowOf(this.#ctx) > row.expires_at;

    if (row.signed_cancel !== null) {
      if (!cancelVerifies(row.signed_cancel, self, approvalId)) {
        return { status: 'refused', reason: 'cancel_invalid' };
      }
      return row.signed_decision === null ? { status: 'denied' } : { status: 'cancelled' };
    }
    if (row.signed_decision === null) {
      if (row.status === 'void') return { status: 'void' };
      return lapsed ? { status: 'expired' } : { status: 'pending' };
    }
    const decision = storedDecision(row.signed_decision, self, approvalId, action);
    if (typeof decision !== 'string') return decision;
    if (decision === 'deny') return { status: 'denied' };
    if (row.status === 'void') return { status: row.scope_json === null ? 'used' : 'void' };
    return lapsed ? { status: 'expired' } : { status: 'approved' };
  }

  /** The approval row and the own identity, or the fail-closed refusal (04 §2.5.1). */
  async #loadApproval(
    approvalId: string,
  ): Promise<{ readonly row: Row<'approvals'>; readonly self: Self } | ApprovalCheckRefusal> {
    if (!approvalIdSchema.safeParse(approvalId).success) {
      return { status: 'refused', reason: 'approval_unknown' };
    }
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('approvals', { approval_id: approvalId }),
    );
    if (row === undefined) return { status: 'refused', reason: 'approval_unknown' };
    const self = await this.#self();
    if ('refusal' in self) return { status: 'refused', reason: 'decision_invalid' };
    return { row, self };
  }
}

type Self = Exclude<SelfView, { readonly refusal: unknown }>;

/** Does the stored `approval.cancel` verify for this approval? */
function cancelVerifies(text: string, self: Self, approvalId: string): boolean {
  const cancel = verifyStoredOwnerAction(text, self);
  return (
    cancel.ok &&
    cancel.signed.body.op === 'approval.cancel' &&
    cancel.signed.body.params.approvalId === approvalId
  );
}

/**
 * The stored decision for this approval (an `approval.decide`, or the batch with exactly one item
 * for this ID), re-verified, with the digest recomputed from `action`.
 */
function storedDecision(
  text: string,
  self: Self,
  approvalId: string,
  action: unknown,
): 'approve' | 'deny' | ApprovalCheckRefusal {
  const decision = verifyStoredOwnerAction(text, self);
  if (!decision.ok) return { status: 'refused', reason: 'decision_invalid' };
  const body = decision.signed.body;
  const items =
    body.op === 'approval.decide'
      ? [body.params]
      : body.op === 'approval.decideBatch'
        ? body.params.items
        : [];
  const mine = items.filter((i) => i.approvalId === approvalId);
  if (mine.length !== 1) return { status: 'refused', reason: 'decision_invalid' };
  const item = mine[0]!;
  if (computeActionDigest(action) !== item.actionDigest) {
    return { status: 'refused', reason: 'digest_mismatch' };
  }
  return item.decision === 'deny' ? 'deny' : 'approve';
}
