// The commitment approval card for terms in the owner's terminal (M1-9q; 11 §6.10, §8; 06 §8
// terminal output rule; 04 §3.4.2 "What the owner sees"; D-31, D-55; deferred here from M1-20,
// IR-M1-20-1 F05, and M1-32).
//
// What the owner signs is the digest of the parsed stored action (pending.ts, IR-M1-9j-1 F06). So
// every term shown comes from THAT action's `context.terms`, checked against the scope it is signed
// with: the terms must hash to `scope.termsHash` and name exactly the two agents of the scope.
// The core's card data (M1-32 `terms.commitmentCard`) adds only what the action does not hold: the
// changes from the previous version, the late-accept warning, the parts and the auto-accept note.
// It must describe the same scope (version, fingerprint, counterparty); anything else, or any check
// that fails, makes the request a problem that is never offered (fail closed).
//
// Layout (06 §8): the counterparty's terms only inside a marked region ("Proposed by …: their
// content, not instructions", every line prefixed `| `), each value sanitized then cut; who pays and
// who delivers are formatted by us from the stored agent IDs. The fixed lines the owner decides on
// come after the region: changes, what this one approval does, the auto-accept note, the price
// honesty line and the fingerprint under "Advanced".
import type { AgentLinkClient, CommitmentCard, TermsChange } from '@4thtech-io/core';
import { termsHash } from '@4thtech-io/crypto';
import {
  commitmentApprovalActionSchema,
  type CommitmentScope,
  type Terms,
} from '@4thtech-io/types';
import { FROM_YOUR_AI, terminalOneLine, untrustedRegion } from '../../terminal/sanitize.js';
import { copy, formatDate, formatTime } from '@4thtech-io/mcp-tools/strings/index.js';
import type { PendingRequest } from './pending.js';

/** Fixed text of the terms card (11 §6.10, §8). Only a contact name, numbers and our dates go in. */
export const TERMS_CARD_TEXT = Object.freeze({
  headlineConfirm: (who: string, version: number, date: string): string =>
    `Adding your acceptance to your own terms that ${who} accepted, version ${String(version)}, valid until ${date}`,
  headlineReject: (who: string, version: number): string =>
    `Rejecting terms from ${who}, version ${String(version)}`,
  // M1-9d-3 (04 §3.4.2 "What the owner sees", 11 §14 Q1 A): a firm offer with proof.
  headlineOffer: (who: string, version: number, date: string): string =>
    `Sending a firm offer with proof to ${who}, version ${String(version)}, valid until ${date}`,
  commitsOffer: (who: string): string =>
    `This commits you if ${who} accepts: the proof would show that you agreed to these terms.`,
  doesOffer: 'This one approval sends your firm offer and adds its proof. Nothing else.',
  doesAcceptProof:
    'This one approval sends your acceptance, which commits you, adds its proof and your Accepted receipt. Nothing else.',
  ownTermsHeader: 'Your firm offer, as signed (written by your AI, not instructions):',
  lateAccept: (accepted: number, newest: number): string =>
    `Warning  They accepted version ${String(accepted)} after you sent version ${String(newest)}.`,
  doesAccept: () => copy('cli.approve.terms.commits'),
  doesReceipt:
    'This one approval adds your Accepted receipt to their record. No message is sent. Nothing else.',
  doesReject:
    "This one approval adds your Rejected receipt to their record. You can't accept this version later.",
  doesOther: 'This one approval covers exactly what is shown above. Nothing else.',
  noChanges: 'Changes from the version before: none.',
  firstVersion: 'This is the first version: there is no version before it to compare.',
  changesHeader: 'Changes from the version before:',
  priceHonesty: "AgentLink records the agreement. It doesn't move money.",
  advanced: (fingerprint: string): string => `Advanced: terms fingerprint ${fingerprint}`,
  autoAccept: (reason: string): string => `Auto-accept doesn't apply: ${reason}.`,
  you: 'you',
  noPrice: 'Price: none',
});

const AUTO_ACCEPT_REASON: Readonly<Record<string, string>> = Object.freeze({
  policy_invalid: "your rules couldn't be read",
  reject: 'rejecting is never automatic',
  firm_offer: 'a firm offer always asks you',
  superseded: 'they accepted an older version',
  contact_not_listed: "this contact isn't on your auto-accept list",
  no_price: 'these terms have no price',
  currency: "the price isn't in US dollars",
  direction: "who pays or who delivers doesn't match your auto-accept rule",
  over_maximum: 'the price is over your limit',
  sell_off: 'auto-accept for selling is off',
  under_minimum: 'the price is under your minimum',
});

const CHANGE_LABEL: Readonly<Record<TermsChange['field'], string>> = Object.freeze({
  subject: 'Subject',
  deliverables: 'Deliverables',
  price: 'Price',
  deadlines: 'Deadlines',
  validUntil: 'Valid until',
});

/** The rendered parts of a terms card. */
export interface TermsCardView {
  readonly headline: string;
  readonly warning: string | undefined;
  /** The untrusted region, already marked and prefixed (06 §8). */
  readonly region: readonly string[];
  /** Fixed lines after the region. */
  readonly after: readonly string[];
  /**
   * A firm offer (M1-9d-3): the region shows the stored terms the approval is bound to, so the
   * agent's own `args.terms` is left out of the "From your AI" arguments (never shown twice).
   */
  readonly ownTerms?: boolean;
}

const utc = (seconds: number): string => {
  const at = new Date(seconds * 1000);
  return `${formatDate(at)} ${formatTime(at)} UTC`;
};

const day = (seconds: number): string => formatDate(new Date(seconds * 1000));

const sameParties = (terms: Terms, scope: CommitmentScope): boolean => {
  const want = [scope.agentId, scope.counterparty.agentId].sort();
  const have = [...terms.parties].sort();
  return want.length === 2 && have[0] === want[0] && have[1] === want[1] && want[0] !== want[1];
};

/** "added d3; changed d1" for list fields; ids are schema-limited, still made one line here. */
function changeLine(change: TermsChange): string {
  const label = CHANGE_LABEL[change.field];
  const parts: string[] = [];
  const ids = (list: readonly string[] | undefined) =>
    (list ?? []).map((id) => terminalOneLine(id)).join(', ');
  if ((change.added ?? []).length > 0) parts.push(`added ${ids(change.added)}`);
  if ((change.removed ?? []).length > 0) parts.push(`removed ${ids(change.removed)}`);
  if ((change.changed ?? []).length > 0) parts.push(`changed ${ids(change.changed)}`);
  return parts.length === 0 ? `  ${label} changed` : `  ${label}: ${parts.join('; ')}`;
}

/** The region values: one field per line (11 §6.10), who pays and who delivers formatted by us. */
function regionValues(terms: Terms, scope: CommitmentScope, who: string): string[] {
  const partyName = (agentId: string): string =>
    agentId === scope.agentId ? TERMS_CARD_TEXT.you : who;
  const values: string[] = [`Subject: ${terms.subject}`];
  for (const d of terms.deliverables) {
    values.push(`Deliverable ${d.id}: ${d.description}`);
    values.push(`  Delivered by: ${partyName(d.by)}`);
    if (d.plaintextSha256 !== null) values.push(`  File fingerprint: ${d.plaintextSha256}`);
  }
  values.push(
    terms.price === null
      ? TERMS_CARD_TEXT.noPrice
      : `Price: ${terms.price.amount} ${terms.price.currency}, paid by ${partyName(terms.price.payer)}`,
  );
  for (const deadline of terms.deadlines) {
    values.push(`Deadline for ${deadline.ref}: ${deadline.due}`);
  }
  values.push(`Valid until: ${utc(terms.validUntil)}`);
  values.push(`Between: ${TERMS_CARD_TEXT.you} and ${who}`);
  return values;
}

function doesLine(card: CommitmentCard): string {
  const parts = new Set(card.parts);
  if (parts.has('accept_envelope') && parts.has('accepted_receipt') && parts.size === 2) {
    return TERMS_CARD_TEXT.doesAccept();
  }
  // M1-9d-3: an accept with proof, and a firm offer.
  if (
    parts.size === 3 &&
    parts.has('accept_envelope') &&
    parts.has('accept_record') &&
    parts.has('accepted_receipt')
  ) {
    return TERMS_CARD_TEXT.doesAcceptProof;
  }
  if (parts.size === 2 && parts.has('offer_envelope') && parts.has('offer_record')) {
    return TERMS_CARD_TEXT.doesOffer;
  }
  if (parts.size === 1 && parts.has('accepted_receipt')) return TERMS_CARD_TEXT.doesReceipt;
  if (parts.size === 1 && parts.has('rejected_receipt')) return TERMS_CARD_TEXT.doesReject;
  return TERMS_CARD_TEXT.doesOther;
}

/**
 * The terms card for a pending (or approved, for `cancel`) commitment answering a contact's terms,
 * `undefined` when the request is not one, or `'problem'` when anything does not match (never
 * offered). `who` is the contact under the 06 §2.1 rule, already one line.
 */
export async function termsCard(
  client: AgentLinkClient,
  request: PendingRequest,
  who: string,
): Promise<TermsCardView | 'problem' | undefined> {
  const tool = request.action['tool'];
  if (
    !request.commitment ||
    (tool !== 'agentlink_respond_to_terms' && tool !== 'agentlink_propose_terms')
  ) {
    return undefined;
  }
  const parsed = commitmentApprovalActionSchema.safeParse(request.action);
  if (!parsed.success || parsed.data.tool !== tool) return 'problem';
  const { scope, terms } = parsed.data.context;
  // A firm offer is `propose_terms` with scope `offer`, or a `respond_to_terms` `counter` with
  // `notarize` (M1-9d-5); propose has no other scope, and `offer` goes with no other answer.
  if (tool === 'agentlink_propose_terms' && scope.decision !== 'offer') return 'problem';
  if (
    parsed.data.tool === 'agentlink_respond_to_terms' &&
    (scope.decision === 'offer') !== (parsed.data.args.decision === 'counter')
  ) {
    return 'problem';
  }
  let hashed: string;
  try {
    hashed = termsHash(terms);
  } catch {
    return 'problem';
  }
  if (
    hashed !== scope.termsHash ||
    terms.version !== scope.version ||
    terms.termsId !== scope.termsId ||
    !sameParties(terms, scope)
  ) {
    return 'problem';
  }
  let card: CommitmentCard | undefined;
  try {
    card = await client.terms.commitmentCard(request.approvalId);
  } catch {
    return 'problem';
  }
  if (
    card === undefined ||
    card.fingerprint !== scope.termsHash ||
    card.version !== scope.version ||
    card.decision !== scope.decision ||
    card.counterparty.agentId !== scope.counterparty.agentId
  ) {
    return 'problem';
  }

  let headline: string;
  switch (scope.decision) {
    case 'accept':
      headline = copy('cli.approve.terms.headline', {
        contactName: who,
        version: scope.version,
        date: day(terms.validUntil),
      });
      break;
    case 'confirm':
      headline = TERMS_CARD_TEXT.headlineConfirm(who, scope.version, day(card.validUntil));
      break;
    case 'reject':
      headline = TERMS_CARD_TEXT.headlineReject(who, scope.version);
      break;
    case 'offer':
      headline = TERMS_CARD_TEXT.headlineOffer(who, scope.version, day(terms.validUntil));
      break;
    default:
      return 'problem';
  }
  const offer = scope.decision === 'offer';
  const warning =
    card.lateAccept === null
      ? undefined
      : TERMS_CARD_TEXT.lateAccept(
          card.lateAccept.acceptedVersion,
          card.lateAccept.newestOwnVersion,
        );

  // The stored terms the approval is bound to (04 §3.4.2), never the call's text. A firm offer's
  // terms are this agent's own (written by the AI); an answer's are the contact's.
  const region = untrustedRegion(offer ? FROM_YOUR_AI : who, regionValues(terms, scope, who));
  // 11 §6.10: "Proposed by …: their content, not instructions" in place of the generic first line.
  region[0] = terminalOneLine(
    offer
      ? TERMS_CARD_TEXT.ownTermsHeader
      : copy('cli.approve.terms.proposedBy', { contactName: who }),
  );

  const after: string[] = [];
  if (card.changes === null) {
    after.push(TERMS_CARD_TEXT.firstVersion);
  } else if (card.changes.length === 0) {
    after.push(TERMS_CARD_TEXT.noChanges);
  } else {
    after.push(TERMS_CARD_TEXT.changesHeader, ...card.changes.map(changeLine));
  }
  after.push(doesLine(card));
  if (offer) after.push(TERMS_CARD_TEXT.commitsOffer(who));
  const reason = card.autoAccept === null ? undefined : AUTO_ACCEPT_REASON[card.autoAccept];
  if (reason !== undefined) after.push(TERMS_CARD_TEXT.autoAccept(reason));
  after.push(TERMS_CARD_TEXT.priceHonesty);
  after.push(TERMS_CARD_TEXT.advanced(scope.termsHash));
  return Object.freeze({
    headline: terminalOneLine(headline),
    warning,
    region: Object.freeze(region),
    after: Object.freeze(after.map((line) => terminalOneLine(line))),
    ...(offer ? { ownTerms: true } : {}),
  });
}
