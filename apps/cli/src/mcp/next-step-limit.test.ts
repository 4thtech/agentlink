// M1-36d-c: a guard for the 500 code point limit of `nextStep` (06 §2.5, toolTextSchema). Every
// nextStep builder is rendered at its worst case (longest agent name, port 65535, longest IDs, the
// `npx` command prefix, the longest tail) and must stay within the limit, so a copy edit that
// pushes one over fails here, not in a user's chat as a generic error.
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import { approvalNextStep } from '../approval/next-step.js';
import { NPX_PREFIX } from '../runtime/cli-prefix.js';
import { FILE_TEXT } from '../tools/files-common.js';
import type { ToolClient, ToolContext } from '../tools/context.js';
import { INVITE_TEXT, acceptRetryStep, approvedNeedsIdStep } from '../tools/invite-common.js';
import { PROOF_TEXT } from '../tools/proofs-common.js';
import {
  RESULT_TEXT,
  finalizeResult,
  pendingApproval,
  resultIsValid,
  withApprovalLink,
  type HandlerOutput,
} from '../tools/result.js';
import { SEND_TEXT } from '../tools/send.js';
import { en } from '../tools/strings/en.js';
import { TERMS_TEXT } from '../tools/terms-common.js';
import { TOOL_TEXT } from '../tools/text.js';
import { approvalLinkNextStep } from './approval-ui.js';

const LIMIT = 500;
const len = (text: string | undefined): number => [...(text ?? '')].length;

const APPROVAL = `apr_${'A'.repeat(22)}`;
const ENVELOPE = 'E'.repeat(43);
const ORIGIN = 'http://localhost:65535';
const URL_ = `${ORIGIN}/approve/${APPROVAL}`;
/** Longest agent name (06 §6): 1 letter then 31 of `[a-z0-9-]`. */
const LONG_NAME = `a${'-'.repeat(31)}`;

function context(agentName: string, withLink: boolean): ToolContext {
  const link = {
    url: URL_,
    origin: ORIGIN,
    nextStep: approvalLinkNextStep(APPROVAL, URL_, agentName, NPX_PREFIX),
  };
  return {
    client: {} as ToolClient,
    clock: () => 1_760_600_000,
    logger: createLogger({ level: 'debug', sink: () => undefined }),
    agentName,
    approvalNextStep: (id) => approvalNextStep(id, agentName, NPX_PREFIX),
    urlOrigins: [],
    ...(withLink ? { approvalLink: () => Promise.resolve(link) } : {}),
  } as ToolContext;
}

/** The tails each tool appends after the shared pending_approval nextStep. */
const TAILS: Record<string, string> = {
  none: '',
  accept: acceptRetryStep(APPROVAL),
  sendProof: SEND_TEXT.proofApprovalTail.replace('{envelopeId}', ENVELOPE),
  sendProofReceipt: SEND_TEXT.proofApprovalTailReceipt.replace('{envelopeId}', ENVELOPE),
};

describe('pending_approval nextStep worst cases stay within 500 code points', () => {
  for (const [tailName, tail] of Object.entries(TAILS)) {
    for (const withLink of [false, true]) {
      it(`${tailName} tail, ${withLink ? 'with the local link' : 'CLI only'}, 32-char agent name`, async () => {
        const ctx = context(LONG_NAME, withLink);
        const base = pendingApproval(ctx, APPROVAL, 'This needs your approval.');
        const handler: HandlerOutput = {
          result: {
            ...base.result,
            nextStep: `${base.result.nextStep ?? ''} ${tail}`.trim(),
          },
        };
        const { output, origins } = await withApprovalLink(handler, ctx);
        // Whatever the helper returns must be valid and, if it is the link version, within limit.
        expect(len(output.result.nextStep)).toBeLessThanOrEqual(LIMIT);
        expect(resultIsValid(output.result, origins)).toBe(true);
        expect(finalizeResult(output, origins).structured.code).toBeUndefined();
        expect(output.result.nextStep).toContain('agentlink_get_approval');
        if (tail !== '') expect(output.result.nextStep).toContain(tail);
      });
    }
  }

  it('measures the worst cases (reported in the PR)', () => {
    const ctx = context(LONG_NAME, true);
    const cli = len(ctx.approvalNextStep(APPROVAL)) + 1 + len(RESULT_TEXT.approvalCheckHint);
    const link =
      len(approvalLinkNextStep(APPROVAL, URL_, LONG_NAME, NPX_PREFIX)) +
      1 +
      len(RESULT_TEXT.approvalCheckHint) +
      1 +
      len(acceptRetryStep(APPROVAL));
    expect(cli).toBeLessThanOrEqual(LIMIT);
    expect(link).toBeLessThanOrEqual(LIMIT);
  });

  it('falls back to the shorter CLI-only text when the link version would be over the limit', async () => {
    const ctx = context(LONG_NAME, true);
    const base = pendingApproval(ctx, APPROVAL, 'This needs your approval.');
    const padded: HandlerOutput = {
      result: { ...base.result, nextStep: `${base.result.nextStep ?? ''} ${'x'.repeat(200)}` },
    };
    const { output } = await withApprovalLink(padded, ctx);
    expect(output.result.url).toBeUndefined();
    expect(output.result.nextStep).toBe(padded.result.nextStep);
  });
});

describe('every fixed nextStep and hint text stays within 500 code points', () => {
  const sheets: Record<string, Record<string, unknown>> = {
    FILE_TEXT,
    INVITE_TEXT,
    PROOF_TEXT,
    RESULT_TEXT,
    SEND_TEXT,
    TERMS_TEXT,
    TOOL_TEXT,
    en,
  };
  const filler = (key: string): string => (/approvalId/i.test(key) ? APPROVAL : ENVELOPE);
  const entries = Object.entries(sheets).flatMap(([sheet, texts]) =>
    Object.entries(texts)
      .filter(([key, value]) => /nextstep|hint|tail/i.test(key) && typeof value === 'string')
      .map(([key, value]) => [`${sheet}.${key}`, value as string] as const),
  );

  it('finds the texts to check', () => {
    expect(entries.length).toBeGreaterThan(30);
  });

  it.each(entries)('%s', (_name, text) => {
    // Longest fill for any {placeholder}: an envelope ID or an approval ID, whichever is longer.
    const filled = text.replace(/\{(\w+)\}/g, (_m, key: string) => filler(key));
    expect(len(filled)).toBeLessThanOrEqual(LIMIT);
  });

  it('the invite retry sentences with the longest ID fit', () => {
    expect(len(acceptRetryStep(APPROVAL))).toBeLessThanOrEqual(LIMIT);
    expect(len(approvedNeedsIdStep(APPROVAL))).toBeLessThanOrEqual(LIMIT);
  });
});
