// `agentlink_propose_terms` (06 §2.2a, §2.0; 04 §3.4; D-55, D-74; M1-9q).
//
// 1. The schema (registry) already checked `TermsInput` field by field; the core re-checks it with
//    its strict zod schema and refuses anything not canonical (INVALID_ARGUMENT, never rewritten).
// 2. The `to` argument is resolved to an active, paired contact (ID or shown name; AMBIGUOUS_CONTACT).
// 3. Core `proposeTerms` (M1-32) fills `termsId`, `version`, `parties`, `previousTermsHash` and
//    `termsHash`, checks `revises` (only the caller's own newest unanswered offer, else
//    USE_RESPOND_TO_TERMS) and sends the `offer`. Free and not a commitment.
// 4. With `notarize` (M1-9d-3): a firm offer, a commitment. The core quotes the proof first
//    (`needs_credits`: nothing sent, nothing asked), then asks the owner once for the offer and
//    its proof (`pending_approval`, the 11 §5.6 proof lines in the summary); the call again with
//    the approvalId sends the offer and adds its proof (`proof`, a ProofStatus).
//
// `clientRequestId` goes to the core, which makes the call idempotent (M1-32-b; 06 §1 rule 6,
// 07 §3.3): a repeat returns the original result and sends nothing; another request under the key is
// IDEMPOTENCY_KEY_REUSED; a concurrent repeat is IN_PROGRESS, as for agentlink_send.
//
// I-5, I-7: the terms, the note and the `to` query are agent-written (steerable) text; none of it
// reaches a summary, `nextStep`, error or log line.
import type { ProposeTermsInput } from '@4thtech-io/core';
import { contactRef, resolveContact } from './contacts.js';
import type { ToolContext } from './context.js';
import {
  fail,
  internalError,
  notAvailable,
  ok,
  pendingApproval,
  type HandlerOutput,
} from './result.js';
import {
  TERMS_TEXT,
  contactNotReady,
  dateOf,
  isoOf,
  nameOf,
  termsApprovalState,
  termsCoreError,
  termsInProgress,
  termsNeedsCredits,
  termsRefusal,
  termsWithProof,
} from './terms-common.js';
import { proofDisclosure, withDisclosure } from './strings/privacy.js';
import { noOwnerCard } from './text.js';

interface ProposeInput {
  to: string;
  terms: Record<string, unknown>;
  revises?: string;
  note?: string;
  notarize?: boolean;
  approvalId?: string;
  clientRequestId?: string;
}

export async function proposeTermsHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const { client, logger } = context;
  const terms = client.terms;
  if (terms === undefined) return notAvailable();
  const { to, revises, note, notarize, approvalId, clientRequestId } = input as ProposeInput;

  const self = await client.self();
  if (self === undefined) {
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
  }
  const resolved = resolveContact(to, await client.contacts());
  if (!resolved.ok) return resolved.output;
  const ref = contactRef(resolved.contact);
  if (resolved.contact.pairing !== 'complete') {
    return contactNotReady();
  }

  const request: ProposeTermsInput = {
    to: resolved.contact.id,
    terms: (input as ProposeInput).terms,
    ...(revises === undefined ? {} : { revises }),
    ...(note === undefined ? {} : { note }),
    // M1-9d-2: a firm offer (06 §2.2a); the core decides it under one commitment scope.
    ...(notarize === undefined ? {} : { notarize }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  };
  let result;
  try {
    result = await terms.propose(request);
  } catch (error) {
    const mapped = termsCoreError(error);
    if (mapped === undefined) throw error; // callTool: fixed INTERNAL
    logger.info('propose terms refused', { kind: 'core' });
    return mapped;
  }

  switch (result.status) {
    case 'ok': {
      logger.info('terms offer sent', { offers: 1 });
      const fields = {
        envelopeId: result.envelopeId,
        thread: result.thread,
        termsId: result.termsId,
        version: result.version,
        termsHash: result.termsHash,
        validUntil: isoOf(result.validUntil),
      };
      if (result.proof === undefined) {
        return ok(
          TERMS_TEXT.offerSent(result.version, nameOf(ref), dateOf(result.validUntil)),
          fields,
        );
      }
      return termsWithProof(
        TERMS_TEXT.firmOfferSent(result.version, nameOf(ref), dateOf(result.validUntil)),
        fields,
        result.proof,
        context,
        self.agentId,
        nameOf(ref),
      );
    }
    case 'needs_credits':
      logger.info('propose terms needs credits', { offers: 0 });
      return termsNeedsCredits(self.agentId, result.topUp, context.payPage);
    case 'rejected':
      logger.info('propose terms refused', { kind: 'terms' });
      return termsRefusal(result.code, false);
    case 'pending_approval':
      // A firm offer (M1-9d-3): one approval for the offer and its proof.
      logger.info('terms approval requested', { requests: 1 });
      return pendingApproval(
        context,
        result.approvalId,
        withDisclosure(TERMS_TEXT.askFirmOffer(nameOf(ref)), proofDisclosure(nameOf(ref))),
      );
    case 'in_progress':
      return termsInProgress();
    case 'approval_state':
      return termsApprovalState(context, 'agentlink_propose_terms', result);
    default:
      return internalError();
  }
}
