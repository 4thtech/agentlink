// The owner approval a proof pack carries (07 §8 `ownerApproval`; 04 §2.5.1, §3.4.2; D-55;
// M1-4d-c). The pack schema already holds the shapes: a signed `approval.decide` that approves, for
// the agent its commitment scope names, or a standing rule's policy hash.
//
// A signed approval is checked, fail closed (`owner_approval_invalid`):
// 1. `sig` is BIP-340 by `body.owner` over taggedHash("agentlink/owner-action/v1",
//    sha256(JCS(body))) (04 §2.5.1);
// 2. `params.actionDigest` = sha256(JCS(action)), so the owner signed exactly this action, scope
//    and terms (04 §3.4.2);
// 3. the scope's `termsHash` is the hash of the stored terms in `action.context.terms` (04 §3.4);
// 4. the scope concerns this record. Either the approving agent made the record (`approver:
//    signer`): a firm offer on an OFFER record, or an accept it notarized on an ACCEPT record; or it
//    is the record's recipient (`approver: recipient`): the scope's counterparty is the record
//    signer, it answers the record's envelope, and the decision fits the record kind (accept on an
//    OFFER, confirm on an ACCEPT, reject on either), on a record that has a recipient. A disclosed
//    recipient must be the approving agent;
// 5. where the signer's card is in the pack, the owner key it names must agree: it is the
//    approval's `owner` when the signer approved, and the scope's `counterparty.ownerKey` when the
//    recipient did.
// The time checks of 04 §2.5.1 (expiry, nonce) applied once, when the core used the approval;
// they are not repeated here. `ownerBound` says whether the pack shows whose owner key signed: only
// the signer's card can, so a recipient's approval is never bound by the pack alone.
//
// A standing rule is reported with its hash: the policy document is not in the pack, so the hash
// cannot be checked here. An approval never changes the verdict on its own.
import {
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeHex,
  encodeHex,
  sha256,
  taggedHash,
  verifyTermsHash,
} from '@4thtech-io/crypto';
import { RECORD_KINDS, type AgentCard, type CommitmentDecision } from '@4thtech-io/types';
import type { ParsedProofPack } from './parse.js';

export type OwnerApprovalResult =
  | { readonly status: 'none' }
  | {
      /** Approved by the owner's standing rule; `policyHash` is not checkable from the pack. */
      readonly status: 'standing_rule';
      readonly policyHash: string;
    }
  | {
      /** The owner's signed approval, checked against this record. */
      readonly status: 'signed';
      /** Who approved: the agent that made the record, or its recipient. */
      readonly approver: 'signer' | 'recipient';
      readonly decision: CommitmentDecision;
      /** The terms the owner approved: bare hex, the hash of the stored terms (04 §3.4). */
      readonly termsHash: string;
      readonly version: number;
      /** The owner key that signed (64 lowercase hex). */
      readonly ownerKey: string;
      /** True only when the signer's card in the pack names this owner key. */
      readonly ownerBound: boolean;
    };

const NONE: OwnerApprovalResult = Object.freeze({ status: 'none' });
const ZERO32 = `0x${'0'.repeat(64)}`;

/** Which record kinds a decision can stand behind, by the approving side (04 §3.4.2). */
const SIGNER_KINDS: Readonly<Partial<Record<CommitmentDecision, readonly number[]>>> =
  Object.freeze({
    offer: Object.freeze([RECORD_KINDS.OFFER]),
    accept: Object.freeze([RECORD_KINDS.ACCEPT]),
  });
const RECIPIENT_KINDS: Readonly<Partial<Record<CommitmentDecision, readonly number[]>>> =
  Object.freeze({
    accept: Object.freeze([RECORD_KINDS.OFFER]),
    confirm: Object.freeze([RECORD_KINDS.ACCEPT]),
    reject: Object.freeze([RECORD_KINDS.OFFER, RECORD_KINDS.ACCEPT]),
  });

/** The card spells a Nostr key `0x` + 64 hex; owner actions and scopes spell it bare (04 §2.4.1). */
const bare = (key: string): string => (key.startsWith('0x') ? key.slice(2) : key);

/**
 * Verifies the pack's `ownerApproval` against its record (already matched to the chain) and the
 * signer's card (already checked, or null). Returns the report, or null when the approval is not
 * valid for this record. Never throws.
 */
export function verifyOwnerApproval(
  pack: ParsedProofPack,
  signerCard: AgentCard | null,
): OwnerApprovalResult | null {
  const approval = pack.ownerApproval;
  if (approval === null) return NONE;
  if ('standingRule' in approval) {
    return Object.freeze({ status: 'standing_rule', policyHash: approval.policyHash });
  }
  try {
    const { signed, action } = approval;
    const body = signed.body;
    // 1. The owner's signature over the exact body.
    const message = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
    if (!bip340Verify(decodeHex(body.owner, { length: 32 }), message, decodeHex(signed.sig))) {
      return null;
    }
    // 2. The body approves exactly this action.
    if (body.params.actionDigest !== encodeHex(sha256(canonicalizeToBytes(action)))) return null;
    // 3. The scope's terms fingerprint is the hash of the stored terms.
    const scope = action.context.scope;
    if (!verifyTermsHash(action.context.terms, scope.termsHash)) return null;

    // 4. The scope concerns this record.
    const record = pack.record;
    const cardOwner = signerCard === null ? null : bare(signerCard.ownerNostr);
    let approver: 'signer' | 'recipient';
    if (scope.agentId === record.signer) {
      approver = 'signer';
      if (!(SIGNER_KINDS[scope.decision] ?? []).includes(record.kind)) return null;
      if (scope.notarize !== true) return null;
      if (pack.recipient !== undefined && pack.recipient.evm !== scope.counterparty.agentId) {
        return null;
      }
      // 5. The signer's card names the owner that signed.
      if (cardOwner !== null && cardOwner !== body.owner) return null;
    } else if (scope.counterparty.agentId === record.signer) {
      approver = 'recipient';
      if (!(RECIPIENT_KINDS[scope.decision] ?? []).includes(record.kind)) return null;
      if (record.recipientCommitment === ZERO32) return null;
      if (scope.answers === null || scope.answers.envelopeHash !== record.envelopeHash) {
        return null;
      }
      if (pack.recipient !== undefined && pack.recipient.evm !== scope.agentId) return null;
      // 5. The scope names the signer's owner as the card does.
      if (cardOwner !== null && cardOwner !== scope.counterparty.ownerKey) return null;
    } else {
      return null;
    }
    return Object.freeze({
      status: 'signed',
      approver,
      decision: scope.decision,
      termsHash: scope.termsHash,
      version: scope.version,
      ownerKey: body.owner,
      ownerBound: approver === 'signer' && cardOwner !== null,
    });
  } catch {
    return null;
  }
}
