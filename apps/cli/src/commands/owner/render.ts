// The approval card in the owner's terminal (M1-9b; 06 §8 terminal output rule, 11 §6.10, §8).
//
// Layout of one card, in this order:
// 1. a fixed header line with the approval ID (checked against its exact pattern);
// 2. for an answer to a contact's terms (M1-9q, terms-card.ts): the commitment headline and any
//    late-accept warning (fixed text, a contact name, numbers and our dates);
// 3. the marked untrusted region(s): every argument the agent chose ("From your AI"), and for an
//    answer to a contact's terms, the terms they sent, one field per line ("Proposed by <contact>").
//    Every value is sanitized first and cut after (src/terminal/sanitize.ts), and every line is
//    prefixed `| `;
// 4. the fixed lines the owner decides on: who, what, cost, expiry, for terms the changes, what the
//    one approval does, the auto-accept note and the fingerprint, then the consequence and "Your AI
//    can't approve this for you." They come AFTER the regions, so nothing inside a region can stand
//    in for them (06 §8). Their only inserted values are a contact name under the 06 §2.1 rule
//    (sanitized to one line again), an exact dollar amount, numbers, ids and UTC dates.
//
// A terms request whose stored terms, scope and core card data do not match is a problem
// (`facts.terms === 'problem'`): approve.ts never offers it.
//
// Everything here is derived from the parsed stored action (pending.ts), never from the row's
// stored summary or any text the agent passed in (IR-M1-8c-1 F-4).
import { renderContactName, type AgentLinkClient } from '@4thtech-io/core';
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import { RESTRICTED_NAME_FALLBACK, isUsdAmount, parseUsd } from '@4thtech-io/types';
import { isApprovalId } from '../../approval/next-step.js';
import { FROM_YOUR_AI, terminalOneLine, untrustedRegion } from '../../terminal/sanitize.js';
import { formatDate, formatTime, formatUsd } from '../../tools/strings/index.js';
import { cardDisclosure } from '../../tools/strings/privacy.js';
import type { PendingRequest } from './pending.js';
import { OWNER_TEXT } from './strings.js';
import { termsCard, type TermsCardView } from './terms-card.js';

/** What a tool does, in 11 §5 vocabulary (fixed text, keyed by the schema-checked tool name). */
const WHAT: Readonly<Record<string, string>> = Object.freeze({
  agentlink_accept_invite: 'Connect with a new contact',
  agentlink_send: 'Send a message',
  agentlink_propose_terms: 'Send a firm offer',
  agentlink_respond_to_terms: 'Answer their terms',
  agentlink_notarize: 'Record a proof',
  agentlink_acknowledge: 'Send a receipt',
  agentlink_export_proof_pack: 'Export a proof with its document key',
});

/** Tools whose headline names the contact the action goes to ("Send a message to “Ana” (…)"). */
const TO_CONTACT: ReadonlySet<string> = new Set([
  'agentlink_send',
  'agentlink_propose_terms',
  'agentlink_acknowledge',
]);

/** The facts a card shows, all fixed text or sanitized one-line values. */
export interface CardFacts {
  /** The contact, under the 06 §2.1 name rule, sanitized to one line. */
  readonly who: string;
  readonly what: string;
  /**
   * M1-11a-ux: the card's plain headline, fixed text plus at most the sanitized
   * “name” (label) form: "Connect with “Ana” (self-declared)", "Send a message to “Ana” (…)", or
   * `what` alone. Never an argument the AI chose (the invite link stays out, I-5).
   */
  readonly headline: string;
  /** "$0.10", or "Free". */
  readonly cost: string;
  /** "12 Oct 2026 14:02 UTC". */
  readonly expires: string;
  /** The one-line summary handed to the signing step (fixed text built from the facts above). */
  readonly summary: string;
  /**
   * For a commitment answering a contact's terms (M1-9q, 11 §6.10): its card, or `'problem'` when
   * the stored action, its scope and the core's card data do not match (never offered).
   */
  readonly terms?: TermsCardView | 'problem';
}

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/**
 * The contact an action is about: `who` under the 06 §2.1 rule, or a fixed fallback; `name` is the
 * sanitized “name” (label) form alone when there is one (a contact, or an inviter's usable name).
 */
interface Party {
  readonly who: string;
  readonly name?: string;
}

async function contactLabel(client: AgentLinkClient, action: JsonObject): Promise<Party> {
  const context = asObject(action['context']);
  const scope = asObject(context?.['scope']);
  const counterparty = asObject(context?.['counterparty']) ?? asObject(scope?.['counterparty']);
  const agentId = counterparty?.['agentId'];
  if (context !== undefined && 'counterparty' in context && context['counterparty'] === null) {
    return { who: OWNER_TEXT.noteToSelf };
  }
  if (typeof agentId !== 'string') return { who: OWNER_TEXT.noContact };
  try {
    const contact = await client.contacts.get(agentId);
    const name = terminalOneLine(renderContactName(contact.display));
    return name === '' ? { who: OWNER_TEXT.notAContact } : { who: name, name };
  } catch {
    return (await inviterLabel(client, action)) ?? { who: OWNER_TEXT.notAContact };
  }
}

/**
 * M1-9zb: who an accept-invite approval connects to, from the invite's verified card (checked again
 * here, nothing stored): the inviter's self-declared name under the 06 §2.1 rule (omitted when
 * restrictName fell back to "Contact <fingerprint>"), then the owner fingerprint. `undefined` when
 * the action is not an accept or the link no longer checks.
 */
async function inviterLabel(
  client: AgentLinkClient,
  action: JsonObject,
): Promise<Party | undefined> {
  if (action['tool'] !== 'agentlink_accept_invite') return undefined;
  const link = asObject(action['args'])?.['inviteUrl'];
  if (typeof link !== 'string') return undefined;
  try {
    const { display, ownerFingerprint } = (await client.pairing.acceptInvite({ link })).contact;
    const fingerprint = terminalOneLine(ownerFingerprint.short);
    if (fingerprint === '') return undefined;
    const fallback = `${RESTRICTED_NAME_FALLBACK} ${ownerFingerprint.short}`;
    const name = display.name === fallback ? '' : terminalOneLine(renderContactName(display));
    const who = OWNER_TEXT.inviter(name, fingerprint);
    return name === '' ? { who } : { who, name };
  } catch {
    return undefined;
  }
}

/** M1-11a-ux: the card's plain headline (see CardFacts.headline). */
function headlineOf(tool: unknown, what: string, party: Party): string {
  const name = party.name;
  if (tool === 'agentlink_accept_invite') {
    return name === undefined ? what : terminalOneLine(OWNER_TEXT.connectWith(name));
  }
  if (typeof tool === 'string' && TO_CONTACT.has(tool) && name !== undefined) {
    return terminalOneLine(OWNER_TEXT.whatTo(what, name));
  }
  return what;
}

/** An exact dollar amount, rounded up to whole cents (11 §5.3: never "about"). */
function costOf(action: JsonObject): string {
  const fee = asObject(asObject(action['context'])?.['fee']);
  const usd = fee?.['usd'];
  if (typeof usd !== 'string' || !isUsdAmount(usd)) return OWNER_TEXT.free;
  const micros = parseUsd(usd);
  const cents = Number((micros + 9_999n) / 10_000n);
  return Number.isSafeInteger(cents) ? formatUsd(cents) : OWNER_TEXT.free;
}

function expiryOf(expiresAt: number): string {
  const at = new Date(expiresAt * 1000);
  return `${formatDate(at)} ${formatTime(at)} UTC`;
}

/** The name for a receipt line: undefined for a fallback label, null for a note to yourself. */
export function recipientName(who: string): string | null | undefined {
  if (who === OWNER_TEXT.noteToSelf) return null;
  if (who === OWNER_TEXT.notAContact || who === OWNER_TEXT.noContact) return undefined;
  return who;
}

export async function cardFacts(
  client: AgentLinkClient,
  request: PendingRequest,
): Promise<CardFacts> {
  const tool = request.action['tool'];
  const what = (typeof tool === 'string' ? WHAT[tool] : undefined) ?? OWNER_TEXT.unknownWhat;
  const party = await contactLabel(client, request.action);
  const who = party.who;
  const cost = costOf(request.action);
  const summary = terminalOneLine(`${what} · ${who} · ${cost}`);
  const terms = await termsCard(client, request, who);
  return Object.freeze({
    who,
    what,
    headline: headlineOf(tool, what, party),
    cost,
    expires: expiryOf(request.expiresAt),
    summary,
    ...(terms === undefined ? {} : { terms }),
  });
}

/** The values of an object as region values: a field name line, then the value (06 §8). */
function fieldValues(object: JsonObject | undefined): unknown[] {
  if (object === undefined) return [];
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(object)) {
    out.push(`${terminalOneLine(key)}:`);
    out.push(typeof value === 'string' ? value : canonicalize(value));
  }
  return out;
}

/**
 * The full card for one request as display lines. `index` numbers it in a batch view. The regions
 * come first and the fixed lines after them (06 §8).
 */
export function cardLines(request: PendingRequest, facts: CardFacts, index?: number): string[] {
  // The ID is an exact-pattern value; anything else would never reach here (pending.ts).
  const id = isApprovalId(request.approvalId) ? request.approvalId : '';
  const lines: string[] = [
    index === undefined ? `Approval ${id}` : `${String(index)}. Approval ${id}`,
  ];
  const terms = facts.terms;
  if (terms === 'problem') {
    // Never offered (approve.ts refuses it); shown so `cancel` still says what it is.
    lines.push(OWNER_TEXT.problemTerms);
    return lines;
  }
  if (terms !== undefined) {
    lines.push(terms.headline);
    if (terms.warning !== undefined) lines.push(terms.warning);
  }
  const args = asObject(request.action['args']);
  // A firm offer (M1-9d-3): its terms are shown from the stored, bound copy in the terms region, so
  // the agent's `args.terms` is not shown here (04 §3.4.2 "What the owner sees").
  const shownArgs =
    terms !== undefined && terms.ownTerms === true && args !== undefined
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'terms'))
      : args;
  lines.push(...untrustedRegion(FROM_YOUR_AI, fieldValues(shownArgs)));
  if (terms !== undefined) lines.push(...terms.region);
  lines.push(
    `Who:      ${facts.who}`,
    `What:     ${facts.what}`,
    `Cost:     ${facts.cost}`,
    `Expires:  ${facts.expires}`,
  );
  if (terms !== undefined) lines.push(...terms.after);
  // 11 §5.6: say what the proof or receipt makes public, from the stored action (never AI text).
  const tool = request.action['tool'];
  if (typeof tool === 'string') lines.push(...cardDisclosure(tool, args, recipientName(facts.who)));
  lines.push(OWNER_TEXT.consequence, OWNER_TEXT.cannotApprove);
  return lines;
}
