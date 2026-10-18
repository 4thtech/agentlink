// M1-11a: the local approval UI's view of one agent's approvals (08 §1; 11 §6.2.1, §8; 04 §2.5.2;
// 06 §2.1, §8; I-4, I-5).
//
// @4thtech-io/node's approval server asks this source for the pending requests, re-reads one before
// a decision and hands the signed object back. It is built from the same reader as `agentlink
// approve` (M1-9b):
// - pending.ts opens each sealed stored action, parses it strictly and recomputes its digest; a row
//   that fails is a problem and is never offered (04 §2.5.2 step 2);
// - render.ts derives the card facts (who under the 06 §2.1 name rule, what, an exact cost, the
//   expiry) from the parsed action, never from the row's stored summary or text the agent passed in
//   (IR-M1-8c-1 F-4); a terms request whose card does not match is a problem too (M1-9q);
// - the action handed back for signing is that same parsed, frozen object (IR-M1-9j-1 F06).
// The AI's arguments go to the page as plain name and value strings in their own "From your AI"
// region; the page renders every value with textContent only (I-5).
//
// I-4: nothing here decides. `apply` is core's `ownerActions.apply`, which verifies the owner
// signature and applies the decision in one store transaction.
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import type {
  ApprovalDetails,
  ApprovalForDecision,
  ApprovalServerSource,
  PendingApprovalView,
} from '@4thtech-io/node';
import { ownerContext } from '../commands/owner/common.js';
import type { OwnerAgent } from '../commands/owner/deps.js';
import {
  isLivePending,
  loadPending,
  readEntry,
  readRow,
  type PendingRequest,
} from '../commands/owner/pending.js';
import { cardFacts, type CardFacts } from '../commands/owner/render.js';

/** Longest name and value shown for one AI argument (the server refuses longer). */
const MAX_NAME = 256;
const MAX_VALUE = 8_000;
const MAX_TERMS_LINES = 200;
const CUT = '…';

/** Why the request waits for the owner, in plain words, by the policy rule that asked (06 §3). */
const RULES: Readonly<Record<string, string>> = Object.freeze({
  'proofs.notarize': 'Your rules ask you to approve every proof.',
  'proofs.perActionMaxUSD': 'This costs more than your limit for one proof.',
  'proofs.dailyBudgetUSD': 'This goes over your daily limit for proofs.',
  'contacts.acceptInvites': 'Your rules ask you to approve every new contact.',
  'commitments.accept': 'Your rules ask you to approve terms before your AI agrees to them.',
  'proofs.allowKeyDisclosure': 'Your rules ask you to approve sharing a document key.',
});
const OUTSIDE_RULES = 'This is outside your rules.';

export interface UiApprovalSourceOptions {
  /** Unix seconds. */
  readonly now: () => number;
}

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** Cuts a string to `max` code points, marking the cut. */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}${CUT}`;
}

function ruleOf(action: JsonObject): string {
  const triggers = asObject(action['context'])?.['triggers'];
  if (!Array.isArray(triggers)) return OUTSIDE_RULES;
  const lines = triggers
    .map((t) => (typeof t === 'string' ? RULES[t] : undefined))
    .filter((line): line is string => line !== undefined);
  return lines.length === 0 ? OUTSIDE_RULES : lines.join(' ');
}

function fromAi(action: JsonObject): { name: string; value: string }[] {
  const args = asObject(action['args']);
  if (args === undefined) return [];
  return Object.entries(args).map(([name, value]) => ({
    name: cut(name, MAX_NAME),
    value: cut(typeof value === 'string' ? value : canonicalize(value), MAX_VALUE),
  }));
}

function detailsOf(request: PendingRequest, facts: CardFacts): ApprovalDetails {
  const terms = facts.terms;
  const lines =
    terms === undefined || terms === 'problem'
      ? undefined
      : [
          terms.headline,
          ...(terms.warning === undefined ? [] : [terms.warning]),
          ...terms.region,
          ...terms.after,
        ].slice(0, MAX_TERMS_LINES);
  return {
    who: facts.who,
    what: facts.what,
    cost: facts.cost,
    expires: facts.expires,
    rule: ruleOf(request.action),
    fromAi: fromAi(request.action).slice(0, 64),
    ...(lines === undefined ? {} : { terms: lines }),
  };
}

/** The view of one checked request, or undefined when it is a problem (never offered). */
async function viewOf(
  agent: OwnerAgent,
  request: PendingRequest,
): Promise<ApprovalForDecision | undefined> {
  const facts = await cardFacts(agent.client, request);
  if (facts.terms === 'problem') return undefined;
  return {
    approvalId: request.approvalId,
    summary: facts.summary,
    actionDigest: request.actionDigest,
    expiresAt: request.expiresAt,
    commitment: request.commitment,
    details: detailsOf(request, facts),
    action: request.action,
    storedDigest: request.storedDigest,
  };
}

/** The approval server's source for one opened agent. Frozen; no member decides anything (I-4). */
export function createUiApprovalSource(
  agent: OwnerAgent,
  options: UiApprovalSourceOptions,
): ApprovalServerSource {
  return Object.freeze<ApprovalServerSource>({
    context: () => ownerContext(agent),
    list: async (): Promise<readonly PendingApprovalView[]> => {
      const views: PendingApprovalView[] = [];
      for (const entry of await loadPending(agent, options.now())) {
        if (entry.kind !== 'ok') continue;
        const full = await viewOf(agent, entry);
        if (full === undefined) continue;
        // The list never carries the action itself, only the view fields.
        views.push({
          approvalId: full.approvalId,
          summary: full.summary,
          actionDigest: full.actionDigest,
          expiresAt: full.expiresAt,
          commitment: full.commitment,
          ...(full.details === undefined ? {} : { details: full.details }),
        });
      }
      return views;
    },
    get: async (approvalId: string): Promise<ApprovalForDecision | undefined> => {
      const row = await readRow(agent, approvalId);
      if (row === undefined || !isLivePending(row, options.now())) return undefined;
      const entry = await readEntry(agent, row);
      if (entry.kind !== 'ok') return undefined;
      return viewOf(agent, entry);
    },
    apply: (signed) => agent.client.ownerActions.apply(signed),
  });
}
