// Shared pieces of the proof tools (M1-9d-2; 06 §2.1 `agentAddress`, `topUpUrl`, §2.4, §1 rule 3;
// 07 §6.3; 11 §5.1; D-40, D-53, D-101; IR-M1-4b-1 L-2).
//
// - Fixed text only (I-5): no slot takes inbound or agent-written text. Slots hold checked values
//   only: a USD amount (`^\d+(\.\d+)?$`), an envelope ID, a tool name.
// - 11 §5.1: user-facing text says "proof", "credits", "agent ID"; never the network's name, a
//   token, "chain", "contract", "on-chain", "transaction" or "gas". The core's and the chain
//   package's own wording is never passed through: their results map by code to the text here.
// - The top-up link (06 §2.1 `topUpUrl`, 08 §1, D-113): `https://{payHost}/#v=1&a=<agent
//   address>&usd=<suggested amount>`, built by the core's `buildTopUpLink` from the shipped pay
//   host. Address and amount sit in the fragment; no network or token is in it. The host is never
//   read from a route, a result or any inbound text. The agent address also travels as its own
//   field (`agentAddress`).
import { PAY_PAGE, type PayPageConfig } from '@4thtech-io/chain';
import {
  CoreError,
  buildTopUpLink,
  suggestTopUpUsd,
  type NotarizeResult,
  type ProofView,
} from '@4thtech-io/core';
import type { ToolContext } from './context.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  ok,
  pendingApproval,
  type HandlerOutput,
} from './result.js';
import { proofDisclosure, topUpDisclosure, withDisclosure } from './strings/privacy.js';
import { noOwnerCard } from './text.js';

const USD = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const ENVELOPE_ID = /^[A-Za-z0-9_-]{22}$/;

/** `$0.10` from a checked USD amount; undefined for anything else (never rendered). */
export function dollars(usd: unknown): string | undefined {
  if (typeof usd !== 'string' || !USD.test(usd)) return undefined;
  const [whole, frac = ''] = usd.split('.');
  return `$${whole ?? '0'}.${(frac + '00').slice(0, Math.max(2, frac.replace(/0+$/, '').length))}`;
}

/**
 * The top-up link (06 §2.1, D-113). Undefined while the pay page is not live (the shipped config
 * says so until the page exists) or when the agent ID is malformed. `shortfallUsd` (a checked USD
 * decimal) sets the suggested amount per 08 §1; without it the link has no `usd`.
 */
export function topUpUrl(
  agentId: string,
  shortfallUsd?: string,
  payPage: PayPageConfig = PAY_PAGE,
): string | undefined {
  if (!payPage.live) return undefined;
  const usd = shortfallUsd === undefined ? undefined : suggestTopUpUsd(shortfallUsd);
  return buildTopUpLink({
    agentAddress: agentId,
    payHost: payPage.host,
    ...(usd === undefined ? {} : { usd }),
  });
}

export const PROOF_TEXT = Object.freeze({
  recorded: 'Proof recorded. {fee} from credits.',
  recordedNoFee: 'Proof recorded.',
  // M1-33d-b: `requestReceipt` on a message that already had proof. Fixed text, no slot (I-5).
  receiptRequestNotAdded:
    'This message already had proof, so no delivery confirmation was asked for.',
  recording: 'The proof is being recorded; this usually takes under a minute.',
  recordingNextStep:
    'Call agentlink_get_proof with this envelopeId in a minute to check that it was recorded.',
  needsCredits: 'Adding proof costs {fee}, and there are not enough credits for it.',
  needsCreditsNoFee: 'There are not enough credits to add proof.',
  needsCreditsNextStep:
    'Adding proof needs credits. Tell the user to add at least {usd} here: {url}. {covers}Messages and files stay free. Then call this tool again.',
  needsCreditsNextStepNoAmount:
    'Adding proof needs credits. Tell the user to add credits here: {url}. {covers}Messages and files stay free. Then call this tool again.',
  covers: '$5 covers {n} proofs. ',
  needsCreditsNoLink:
    'Tell the user there are not enough credits to add proof, and that adding credits is not available yet in this version of AgentLink (messages and files stay free). Do not give a link.',
  approval: "Adding proof needs the owner's approval, so nothing was recorded yet.",
  failed: "The proof couldn't be recorded.",
  failedNextStep:
    'Tell the user the proof was not recorded. They can run `agentlink doctor` in their own terminal to see why.',
  unavailable: "Adding proof isn't available on this machine, so nothing was recorded.",
  unavailableNextStep:
    'Tell the user proof needs AgentLink set up with proof support. They can run `agentlink doctor` to check.',
  notFound:
    "That message wasn't found among the messages this agent sent, so nothing was recorded.",
  notFoundNextStep: 'Check the envelopeId in agentlink_inbox (with includeSent), then call again.',
  notNotarizable: "This kind of message can't get a proof, so nothing was recorded.",
  notNotarizableNextStep: 'Add proof only to a text, note, request, delivery or file message.',
  useTermsTools:
    'Offers and answers to offers get their proof through the terms tools, so nothing was recorded.',
  useTermsToolsNextStep:
    'Use agentlink_propose_terms or agentlink_respond_to_terms with notarize true for a recorded offer or acceptance.',
  policyDenied: "The owner's rules don't allow adding proof here, so nothing was recorded.",
  policyDeniedNextStep:
    'Tell the user their AgentLink rules blocked this. Only they can change the rules.',
  cardExpired: "This agent's profile expires too soon to add proof, so nothing was recorded.",
  cardExpiredNextStep:
    "Tell the user to renew this agent's profile in their own terminal (`agentlink owner`), then try again.",
  network: "Proof recording can't be reached right now, so nothing was recorded.",
  networkNextStep:
    'Try again in a few minutes. If it keeps failing, the user can run `agentlink doctor`.',
  unsupported: "That proof option isn't supported in this version, so nothing was recorded.",
  unsupportedNextStep:
    'Call again without that override: AgentLink picks where to record the proof automatically.',
  approvalInvalid: "That approval can't be used for this request, so nothing was done.",
  approvalInvalidNextStep:
    'Call the tool again without approvalId to ask the owner again, or check it with agentlink_get_approval.',
  policyChanged: "The owner's rules changed while this ran, so nothing was recorded.",
  policyChangedNextStep: 'Call the tool again; it checks the current rules.',
});

const fill = (template: string, slots: Readonly<Record<string, string>>): string =>
  Object.entries(slots).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );

/** How many proofs $5 covers at this fee (06 §2.4), or undefined when the fee is unknown or zero. */
function proofsPerFiveDollars(feeUsd: string | undefined): number | undefined {
  if (feeUsd === undefined || !USD.test(feeUsd)) return undefined;
  const fee = Number(feeUsd);
  return fee > 0 ? Math.floor(5 / fee + 1e-9) : undefined;
}

/**
 * The `needs_credits` result (06 §1 rule 3, §2.1, §2.4): agent address and the top-up link. The
 * route's `usd` is the shortfall: it sets "add at least" and the link's suggested amount.
 */
export function needsCredits(
  agentId: string,
  route: { readonly feeUsd?: string; readonly usd?: string } | undefined,
  fields: Readonly<Record<string, unknown>> = {},
  payPage: PayPageConfig = PAY_PAGE,
): HandlerOutput {
  const shortfall = dollars(route?.usd) === undefined ? undefined : route?.usd;
  const url = topUpUrl(agentId, shortfall, payPage);
  const fee = dollars(route?.feeUsd);
  const summary =
    fee === undefined ? PROOF_TEXT.needsCreditsNoFee : fill(PROOF_TEXT.needsCredits, { fee });
  const proofs = proofsPerFiveDollars(route?.feeUsd);
  const covers = proofs === undefined ? '' : fill(PROOF_TEXT.covers, { n: String(proofs) });
  const add = dollars(shortfall);
  const nextStep =
    url === undefined
      ? PROOF_TEXT.needsCreditsNoLink
      : add === undefined
        ? fill(PROOF_TEXT.needsCreditsNextStepNoAmount, { url, covers })
        : fill(PROOF_TEXT.needsCreditsNextStep, { usd: add, url, covers });
  // 11 §5.6: the top-up method says the paying account is publicly linked (D-109).
  const stepText = url === undefined ? nextStep : withDisclosure(nextStep, topUpDisclosure());
  return fail('needs_credits', summary, stepText, undefined, {
    ...fields,
    agentAddress: agentId,
    ...(url === undefined ? {} : { topUpUrl: url }),
  });
}

/**
 * The ProofStatus fields of a result (06 §2.4): recordId, fee, receipts, and the proof network
 * under `advanced` only (M1-26-b; D-40, 11 §5.1).
 */
export function proofFields(view: {
  readonly chain?: string;
  readonly recordId?: string;
  readonly fee?: { readonly token: string; readonly amount: string; readonly usd: string };
  readonly receipts?: readonly { readonly type: string; readonly at: string }[];
}): Record<string, unknown> {
  return {
    ...(view.chain === undefined ? {} : { advanced: { chain: view.chain } }),
    ...(view.recordId === undefined ? {} : { recordId: view.recordId }),
    ...(view.fee === undefined
      ? {}
      : { fee: { token: view.fee.token, amount: view.fee.amount, usd: view.fee.usd } }),
    receipts: (view.receipts ?? []).map((r) => ({ type: r.type, at: r.at })),
  };
}

/** Core proof refusal codes (06 §1 rule 3): status and fixed text, by code. */
export function proofRefusal(code: string): HandlerOutput {
  switch (code) {
    case 'PROOFS_UNAVAILABLE':
      return fail('error', PROOF_TEXT.unavailable, PROOF_TEXT.unavailableNextStep, code);
    case 'ENVELOPE_NOT_FOUND':
      return fail('not_found', PROOF_TEXT.notFound, PROOF_TEXT.notFoundNextStep, code);
    case 'NOT_NOTARIZABLE':
      return fail('rejected', PROOF_TEXT.notNotarizable, PROOF_TEXT.notNotarizableNextStep, code);
    case 'USE_TERMS_TOOLS':
      return fail('error', PROOF_TEXT.useTermsTools, PROOF_TEXT.useTermsToolsNextStep, code);
    case 'POLICY_DENIED':
      return fail('rejected', PROOF_TEXT.policyDenied, PROOF_TEXT.policyDeniedNextStep, code);
    case 'CARD_EXPIRED':
      return fail('rejected', PROOF_TEXT.cardExpired, PROOF_TEXT.cardExpiredNextStep, code);
    case 'CHAIN_UNAVAILABLE':
      return fail('error', PROOF_TEXT.network, PROOF_TEXT.networkNextStep, code);
    case 'UNSUPPORTED_CHAIN':
      return fail('rejected', PROOF_TEXT.unsupported, PROOF_TEXT.unsupportedNextStep, code);
    case 'APPROVAL_INVALID':
      return fail('rejected', PROOF_TEXT.approvalInvalid, PROOF_TEXT.approvalInvalidNextStep, code);
    case 'POLICY_CHANGED':
      return fail('rejected', PROOF_TEXT.policyChanged, PROOF_TEXT.policyChangedNextStep, code);
    default:
      return internalError();
  }
}

/** Codes of `@4thtech-io/chain` errors that mean "the network did not answer" (07 §6). */
const NETWORK_CODE = /^(rpc_|chain_unavailable|timeout|network|submitter_)/;

/**
 * A thrown error from a proof call: a CoreError or a chain package error becomes fixed text by its
 * code (IR-M1-4b-1 L-2); its message (which can name a contract, an RPC URL or a value) is never
 * read. Anything else is rethrown for callTool's fixed INTERNAL.
 */
export function proofThrown(error: unknown): HandlerOutput {
  if (error instanceof CoreError) {
    if (error.code === 'identity_missing') {
      return fail('needs_setup', noOwnerCard().summary, noOwnerCard().nextStep);
    }
    if (error.code === 'transport_unavailable') {
      return fail('error', PROOF_TEXT.network, PROOF_TEXT.networkNextStep, 'NETWORK');
    }
    throw error;
  }
  const name = error instanceof Error ? error.name : '';
  const code = (error as { code?: unknown } | null)?.code;
  if (
    (name === 'ChainError' || name === 'ChainInputError' || name === 'SubmitterError') &&
    typeof code === 'string'
  ) {
    return NETWORK_CODE.test(code)
      ? fail('error', PROOF_TEXT.network, PROOF_TEXT.networkNextStep, 'NETWORK')
      : fail('error', PROOF_TEXT.failed, PROOF_TEXT.failedNextStep, 'PROOF_FAILED');
  }
  throw error;
}

/** Fails with needs_setup when the agent has no identity yet; otherwise undefined. */
export async function needsIdentity(
  context: ToolContext,
): Promise<{ readonly agentId: string } | HandlerOutput> {
  const self = await context.client.self();
  if (self === undefined) {
    const text = noOwnerCard(context.agentName);
    return fail('needs_setup', text.summary, text.nextStep);
  }
  return { agentId: self.agentId };
}

export const isOutput = (value: unknown): value is HandlerOutput =>
  typeof value === 'object' && value !== null && 'result' in value;

const toldThisSession = new WeakSet<object>();

/** True once per session (per core client): the first proof says what a proof makes public. */
function firstProofOfSession(context: ToolContext): boolean {
  if (toldThisSession.has(context.client)) return false;
  toldThisSession.add(context.client);
  return true;
}

/**
 * A core `notarize` result as a ProofStatus result (06 §2.4). `fields` are added to every result
 * (agentlink_send's envelope fields); `approvalSummary` and `nextStepTail` let a caller word the
 * approval (send: the message is already sent).
 */
export function notarizeOutput(
  result: NotarizeResult,
  context: ToolContext,
  agentId: string,
  options: {
    readonly fields?: Readonly<Record<string, unknown>>;
    readonly approvalSummary?: string;
    readonly approvalNextStepTail?: string;
    /** The recipient under the name rule (06 §2.1), when the caller knows it (send). */
    readonly contactName?: string;
  } = {},
): HandlerOutput {
  const fields = options.fields ?? {};
  const disclosure = proofDisclosure(options.contactName);
  // M1-33d (06 §2.4, 11 §5.6): a proof that asks for a delivery receipt always says what the
  // receipt makes public; any other proof says it the first time in a session.
  const recorded = result.status === 'ok' || result.status === 'submitted';
  // M1-33d-b: a request on a message that already had proof was not added; the result says so in
  // a field and a fixed line, so the agent cannot claim it asked.
  const notAdded = recorded && result.receiptRequestNotAdded === true;
  // Nothing new was recorded or asked then, so that result has the not-added line instead of the
  // disclosure (and leaves the session's first-proof disclosure for the next proof).
  const disclose = (text: string): string => {
    if (notAdded) return `${text} ${PROOF_TEXT.receiptRequestNotAdded}`;
    return firstProofOfSession(context) || (recorded && result.receiptRequested === true)
      ? withDisclosure(text, disclosure)
      : text;
  };
  const notAddedField = notAdded ? { receiptRequestNotAdded: true } : {};
  switch (result.status) {
    case 'ok': {
      const fee = dollars(result.fee.usd);
      const text =
        fee === undefined ? PROOF_TEXT.recordedNoFee : fill(PROOF_TEXT.recorded, { fee });
      return ok(disclose(text), {
        ...fields,
        ...proofFields(result),
        ...notAddedField,
      });
    }
    case 'submitted':
      return fail(
        'submitted',
        disclose(PROOF_TEXT.recording),
        PROOF_TEXT.recordingNextStep,
        undefined,
        { ...fields, ...proofFields(result), ...notAddedField },
      );
    case 'needs_credits':
      return needsCredits(
        agentId,
        result.topUp,
        {
          ...fields,
          ...(result.recordId === undefined ? {} : { recordId: result.recordId }),
          receipts: [],
        },
        context.payPage,
      );
    case 'error':
      return fail('error', PROOF_TEXT.failed, PROOF_TEXT.failedNextStep, result.code, {
        ...fields,
        recordId: result.recordId,
        receipts: [],
      });
    case 'pending_approval': {
      const output = pendingApproval(
        context,
        result.approvalId,
        withDisclosure(options.approvalSummary ?? PROOF_TEXT.approval, disclosure),
        { ...fields, receipts: [] },
      );
      if (options.approvalNextStepTail === undefined) return output;
      return {
        result: {
          ...output.result,
          nextStep: `${String(output.result.nextStep)} ${options.approvalNextStepTail}`,
        },
      };
    }
    case 'rejected':
      return proofRefusal(result.code);
    default:
      return internalError();
  }
}

/** The ProofStatus of a stored proof (06 §2.4 `agentlink_get_proof`), by its stored status. */
export function proofViewOutput(
  view: ProofView,
  agentId: string,
  payPage?: PayPageConfig,
): HandlerOutput {
  const fields = proofFields(view);
  switch (view.status) {
    case 'recorded':
    case 'announced':
    case 'received': {
      const fee = dollars(view.fee?.usd);
      return ok(
        view.status === 'received' || fee === undefined
          ? PROOF_TEXT.recordedNoFee
          : fill(PROOF_TEXT.recorded, { fee }),
        fields,
      );
    }
    case 'signed':
    case 'pending':
      return fail(
        'submitted',
        PROOF_TEXT.recording,
        PROOF_TEXT.recordingNextStep,
        undefined,
        fields,
      );
    case 'needs_credits':
      return needsCredits(
        agentId,
        view.fee === undefined ? undefined : { feeUsd: view.fee.usd },
        fields,
        payPage,
      );
    case 'failed':
    case 'released':
    case 'replaced':
      return fail('error', PROOF_TEXT.failed, PROOF_TEXT.failedNextStep, 'RECORD_FAILED', fields);
    case 'conflict':
      return fail('error', PROOF_TEXT.failed, PROOF_TEXT.failedNextStep, 'RECORD_CONFLICT', fields);
    default:
      return internalError();
  }
}

/** Exactly one of `envelopeId` and `recordId` (06 §2.4 `{envelopeId?, recordId?}`). */
export function oneTarget(
  input: Readonly<Record<string, unknown>>,
): { readonly envelopeId: string } | { readonly recordId: string } | undefined {
  const { envelopeId, recordId } = input;
  if (typeof envelopeId === 'string' && recordId === undefined) {
    return ENVELOPE_ID.test(envelopeId) ? { envelopeId } : undefined;
  }
  if (typeof recordId === 'string' && envelopeId === undefined) return { recordId };
  return undefined;
}

export { invalidArgument, notAvailable };
