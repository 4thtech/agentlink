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
// M1-11a-ux: the card leads with a plain headline (render.ts) and an accept-invite's
// `inviteUrl` is left out: the link is the capability that opens the invite, and the owner decides on
// who it connects to (the Who line, from the verified invite card), never on the link itself.
//
// SEC-CARD-FULLTEXT (08 §1 "What the card shows"; 11 §5, §6.2.1): the card is decidable from
// app-decoded fields alone. `content` is the exact text the request is about, in full and inert
// (never cut, never the AI's description of it): for a paid send from the digest-bound `args.text`,
// for a proof, receipt or key disclosure from the stored envelope the action names (core
// `proofs.approvalContent`, which checks the envelope hash or record). Check codes (>= 80 bits) for
// the envelope and each file. An envelope that cannot be read marks the card `contentMissing`: the
// server and the page then offer no Approve (fail closed).
//
// I-4: nothing here decides. `apply` is core's `ownerActions.apply`, which verifies the owner
// signature and applies the decision in one store transaction.
import { isPaidPendingAction } from '@4thtech-io/core';
import { FILE_KIND_LABELS, fileKindOf } from '@4thtech-io/types';
import {
  APPROVAL_CONTENT_FILES_MAX,
  APPROVAL_CONTENT_MAX,
  checkCode,
  inertText,
  textLength,
  type ApprovalContent,
  type ApprovalContentFile,
} from '@4thtech-io/types/ui-contract/approval-content';
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
import { cardFacts, HIDDEN_ARGS, recipientName, type CardFacts } from '../commands/owner/render.js';
import { cardDisclosure } from '@4thtech-io/mcp-tools/strings/privacy.js';

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

/** 11 §5.6: what the proof or receipt makes public, fixed text chosen by the tool (never AI text). */
function disclosureOf(action: JsonObject, facts: CardFacts): string[] {
  const tool = action['tool'];
  return typeof tool === 'string'
    ? cardDisclosure(tool, asObject(action['args']), recipientName(facts.who))
    : [];
}

function fromAi(action: JsonObject): { name: string; value: string }[] {
  const args = asObject(action['args']);
  if (args === undefined) return [];
  const tool = action['tool'];
  const hidden = (typeof tool === 'string' ? HIDDEN_ARGS[tool] : undefined) ?? [];
  return Object.entries(args)
    .filter(([name]) => !hidden.includes(name))
    .map(([name, value]) => ({
      name: cut(name, MAX_NAME),
      value: cut(typeof value === 'string' ? value : canonicalize(value), MAX_VALUE),
    }));
}

/** The fixed label of the content block, by tool (11 §5). */
const CONTENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  agentlink_send: 'Exactly what will be sent',
  agentlink_notarize: 'The message this proof is for',
  agentlink_acknowledge: 'The message your receipt answers',
  agentlink_export_proof_pack: 'The message whose content will be shared',
});

/** "980 bytes", "12 KB", "3.4 MB": exact enough to compare, never "about". */
function sizeText(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'GB'}`;
}

/** A file name as one inert line. */
const nameLine = (name: string): string => inertText(name).replace(/[\n\t]/g, ' ');

function fileView(name: string, size: number, sha256: string): ApprovalContentFile {
  return {
    name: nameLine(name),
    size: sizeText(size),
    // From the name alone: the sender's media type is never trusted (file-kind.ts).
    type: FILE_KIND_LABELS[fileKindOf(name)],
    checkCode: checkCode(sha256),
  };
}

type ContentFacts =
  { readonly content: ApprovalContent } | { readonly contentMissing: true } | Record<string, never>;

/** The basename of a path argument, for a file not sent yet (the content holds no path). */
const baseName = (path: unknown): string =>
  typeof path === 'string' ? (path.split(/[\\/]/).pop() ?? '') : '';

/** The card's content block (see the file header); fails closed to `contentMissing`. */
async function contentOf(agent: OwnerAgent, action: JsonObject): Promise<ContentFacts> {
  const tool = action['tool'];
  if (typeof tool !== 'string') return {};
  const label = CONTENT_LABEL[tool];
  if (label === undefined) return {};
  try {
    if (tool === 'agentlink_send') {
      const args = asObject(action['args']);
      const text = args?.['text'];
      const body = args?.['body'];
      const raw =
        typeof text === 'string' ? text : body === undefined ? '' : canonicalize(body as JsonValue);
      const file = asObject(asObject(action['context'])?.['file']);
      const sha = file?.['plaintextSha256'];
      const size = file?.['size'];
      const files =
        typeof sha === 'string' && typeof size === 'number'
          ? [fileView(baseName(args?.['path']) || 'File', size, sha)]
          : [];
      if (raw.length > APPROVAL_CONTENT_MAX) return { contentMissing: true };
      return { content: { label, text: inertText(raw), length: textLength(raw), files } };
    }
    const found = await agent.client.proofs.approvalContent(action);
    if (found === undefined) return {};
    if (found === 'missing') return { contentMissing: true };
    if (found.text.length > APPROVAL_CONTENT_MAX) return { contentMissing: true };
    if (found.files.length > APPROVAL_CONTENT_FILES_MAX) return { contentMissing: true };
    return {
      content: {
        label,
        text: inertText(found.text),
        length: textLength(found.text),
        checkCode: checkCode(found.envelopeHash),
        files: found.files.map((f) => fileView(f.name, f.size, f.plaintextSha256)),
      },
    };
  } catch {
    // Anything that does not decode is never shown as if it were the content.
    return { contentMissing: true };
  }
}

function detailsOf(
  request: PendingRequest,
  facts: CardFacts,
  content: ContentFacts,
): ApprovalDetails {
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
    headline: facts.headline,
    who: facts.who,
    what: facts.what,
    cost: facts.cost,
    expires: facts.expires,
    rule: [ruleOf(request.action), ...disclosureOf(request.action, facts)].join(' '),
    fromAi: fromAi(request.action).slice(0, 64),
    ...(lines === undefined ? {} : { terms: lines }),
    ...content,
  };
}

/** The view of one checked request, or undefined when it is a problem (never offered). */
async function viewOf(
  agent: OwnerAgent,
  request: PendingRequest,
): Promise<ApprovalForDecision | undefined> {
  const facts = await cardFacts(agent.client, request);
  if (facts.terms === 'problem') return undefined;
  const content = await contentOf(agent, request.action);
  return {
    approvalId: request.approvalId,
    summary: facts.summary,
    actionDigest: request.actionDigest,
    expiresAt: request.expiresAt,
    commitment: request.commitment,
    details: detailsOf(request, facts, content),
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
          // M1-PAY-CONFIRM-b: whether it carries a fee (never a list item, 04 §2.5.3 rule 7).
          paid: isPaidPendingAction(full.action),
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
