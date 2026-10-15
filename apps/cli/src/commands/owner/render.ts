// The approval card in the owner's terminal (M1-9b; 06 §8 terminal output rule, 11 §6.10, §8).
//
// Layout of one card, in this order:
// 1. a fixed header line with the approval ID (checked against its exact pattern);
// 2. the marked untrusted region(s): every argument the agent chose ("From your AI"), and for an
//    answer to a contact's terms, the terms they sent ("From <contact>"). Every value is sanitized
//    first and cut after (src/terminal/sanitize.ts), and every line is prefixed `| `;
// 3. the fixed lines the owner decides on: who, what, cost, expiry, consequence, and "Your AI can't
//    approve this for you." They come AFTER the regions, so nothing inside a region can stand in
//    for them (06 §8). Their only inserted values are a contact name under the 06 §2.1 rule (sanitized
//    to one line again), an exact dollar amount and a UTC date.
//
// Everything here is derived from the parsed stored action (pending.ts), never from the row's
// stored summary or any text the agent passed in (IR-M1-8c-1 F-4).
import { renderContactName, type AgentLinkClient } from '@agentlink/core';
import { canonicalize, type JsonObject, type JsonValue } from '@agentlink/crypto';
import { isUsdAmount, parseUsd } from '@agentlink/types';
import { isApprovalId } from '../../approval/next-step.js';
import { FROM_YOUR_AI, terminalOneLine, untrustedRegion } from '../../terminal/sanitize.js';
import { copy, formatDate, formatTime, formatUsd } from '../../tools/strings/index.js';
import type { PendingRequest } from './pending.js';
import { OWNER_TEXT } from './strings.js';

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

/** The facts a card shows, all fixed text or sanitized one-line values. */
export interface CardFacts {
  /** The contact, under the 06 §2.1 name rule, sanitized to one line. */
  readonly who: string;
  readonly what: string;
  /** "$0.10", or "Free". */
  readonly cost: string;
  /** "12 Oct 2026 14:02 UTC". */
  readonly expires: string;
  /** The one-line summary handed to the signing step (fixed text built from the facts above). */
  readonly summary: string;
}

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** The contact an action is about, under the 06 §2.1 rule, or a fixed fallback. */
async function contactLabel(client: AgentLinkClient, action: JsonObject): Promise<string> {
  const context = asObject(action['context']);
  const scope = asObject(context?.['scope']);
  const counterparty = asObject(context?.['counterparty']) ?? asObject(scope?.['counterparty']);
  const agentId = counterparty?.['agentId'];
  if (context !== undefined && 'counterparty' in context && context['counterparty'] === null) {
    return OWNER_TEXT.noteToSelf;
  }
  if (typeof agentId !== 'string') return OWNER_TEXT.noContact;
  try {
    const contact = await client.contacts.get(agentId);
    const name = terminalOneLine(renderContactName(contact.display));
    return name === '' ? OWNER_TEXT.notAContact : name;
  } catch {
    return OWNER_TEXT.notAContact;
  }
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

export async function cardFacts(
  client: AgentLinkClient,
  request: PendingRequest,
): Promise<CardFacts> {
  const tool = request.action['tool'];
  const what = (typeof tool === 'string' ? WHAT[tool] : undefined) ?? OWNER_TEXT.unknownWhat;
  const who = await contactLabel(client, request.action);
  const cost = costOf(request.action);
  const summary = terminalOneLine(`${what} · ${who} · ${cost}`);
  return Object.freeze({ who, what, cost, expires: expiryOf(request.expiresAt), summary });
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

/** The terms a contact sent, when this action answers them: their content, not the agent's. */
function contactTerms(action: JsonObject): JsonObject | undefined {
  if (action['tool'] !== 'agentlink_respond_to_terms') return undefined;
  return asObject(asObject(action['context'])?.['terms']);
}

/** The commitment headline for accepting a contact's terms (11 §6.10), or undefined. */
function termsHeadline(action: JsonObject, who: string): string | undefined {
  if (action['tool'] !== 'agentlink_respond_to_terms') return undefined;
  if (asObject(action['args'])?.['decision'] !== 'accept') return undefined;
  const scope = asObject(asObject(action['context'])?.['scope']);
  const version = scope?.['version'];
  const expiresAt = scope?.['expiresAt'];
  if (typeof version !== 'number' || typeof expiresAt !== 'number') return undefined;
  return copy('cli.approve.terms.headline', {
    contactName: who,
    version,
    date: formatDate(new Date(expiresAt * 1000)),
  });
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
  const headline = request.commitment ? termsHeadline(request.action, facts.who) : undefined;
  if (headline !== undefined) lines.push(terminalOneLine(headline));
  const args = asObject(request.action['args']);
  lines.push(...untrustedRegion(FROM_YOUR_AI, fieldValues(args)));
  const terms = contactTerms(request.action);
  if (terms !== undefined) lines.push(...untrustedRegion(facts.who, fieldValues(terms)));
  lines.push(
    `Who:      ${facts.who}`,
    `What:     ${facts.what}`,
    `Cost:     ${facts.cost}`,
    `Expires:  ${facts.expires}`,
  );
  if (headline !== undefined) lines.push(copy('cli.approve.terms.commits'));
  lines.push(OWNER_TEXT.consequence, OWNER_TEXT.cannotApprove);
  return lines;
}
