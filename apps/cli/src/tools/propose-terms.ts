// `agentlink_propose_terms` (06 §2.2a, §2.0; 04 §3.4; D-55, D-74; M1-9q).
//
// 1. The schema (registry) already checked `TermsInput` field by field; the core re-checks it with
//    its strict zod schema and refuses anything not canonical (INVALID_ARGUMENT, never rewritten).
// 2. The `to` argument is resolved to an active, paired contact (ID or shown name; AMBIGUOUS_CONTACT).
// 3. Core `proposeTerms` (M1-32) fills `termsId`, `version`, `parties`, `previousTermsHash` and
//    `termsHash`, checks `revises` (only the caller's own newest unanswered offer, else
//    USE_RESPOND_TO_TERMS) and sends the `offer`. Free and not a commitment; a firm offer
//    (`notarize`) arrives with M1-9d, so no M1a call returns `pending_approval`.
//
// `clientRequestId` is accepted by the frozen schema, but the core terms flow has no idempotency key
// yet: a repeated call sends a new offer (reported as a gap on the PR; nothing is a commitment).
//
// I-5, I-7: the terms, the note and the `to` query are agent-written (steerable) text; none of it
// reaches a summary, `nextStep`, error or log line.
import type { ProposeTermsInput } from '@agentlink/core';
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
  termsCoreError,
  termsRefusal,
} from './terms-common.js';
import { TOOL_TEXT } from './text.js';

interface ProposeInput {
  to: string;
  terms: Record<string, unknown>;
  revises?: string;
  note?: string;
  approvalId?: string;
}

export async function proposeTermsHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const { client, logger } = context;
  const terms = client.terms;
  if (terms === undefined) return notAvailable();
  const { to, revises, note, approvalId } = input as ProposeInput;

  if ((await client.self()) === undefined) {
    return fail('needs_setup', TOOL_TEXT.noIdentity, TOOL_TEXT.setupNextStep);
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
    ...(approvalId === undefined ? {} : { approvalId }),
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
    case 'ok':
      logger.info('terms offer sent', { offers: 1 });
      return ok(TERMS_TEXT.offerSent(result.version, nameOf(ref), dateOf(result.validUntil)), {
        envelopeId: result.envelopeId,
        thread: result.thread,
        termsId: result.termsId,
        version: result.version,
        termsHash: result.termsHash,
        validUntil: isoOf(result.validUntil),
      });
    case 'rejected':
      logger.info('propose terms refused', { kind: 'terms' });
      return termsRefusal(result.code, false);
    case 'pending_approval':
      // A firm offer (M1-9d); unreachable in M1a, handled so the result is never undefined.
      return pendingApproval(context, result.approvalId, TERMS_TEXT.askFirmOffer(nameOf(ref)));
    default:
      return internalError();
  }
}
