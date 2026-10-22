// M1-36d (F5a): the real approval texts with the get_approval hint and the accept sentence still fit
// the 500 code point limit and keep the local approval link (the fixed-text rules of 06 §1 rule 3).
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import { approvalNextStep } from '../approval/next-step.js';
import type { ToolClient, ToolContext } from '../tools/context.js';
import { acceptRetryStep } from '../tools/invite-common.js';
import {
  finalizeResult,
  pendingApproval,
  resultIsValid,
  withApprovalLink,
  type HandlerOutput,
} from '../tools/result.js';
import { approvalLinkNextStep } from './approval-ui.js';

const APPROVAL = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const ORIGIN = 'http://localhost:45123';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client: {} as ToolClient,
    clock: () => 1_760_600_000,
    logger: createLogger({ level: 'debug', sink: () => undefined }),
    agentName: 'default',
    approvalNextStep: (id) => approvalNextStep(id, 'default'),
    urlOrigins: [],
    ...overrides,
  };
}

describe('approval nextStep with the get_approval hint', () => {
  it('keeps the hint, a valid url and 500 code points with the local link and the accept sentence', async () => {
    const url = `${ORIGIN}/approve/${APPROVAL}`;
    const link = {
      url,
      origin: ORIGIN,
      nextStep: approvalLinkNextStep(APPROVAL, url, 'claude-code'),
    };
    const ctx = context({
      agentName: 'claude-code',
      approvalNextStep: (id) => approvalNextStep(id, 'claude-code'),
      approvalLink: () => Promise.resolve(link),
    });
    const base = pendingApproval(ctx, APPROVAL, 'This needs your approval.');
    const withRetry: HandlerOutput = {
      result: {
        ...base.result,
        nextStep: `${base.result.nextStep ?? ''} ${acceptRetryStep(APPROVAL)}`.trim(),
      },
    };
    const { output, origins } = await withApprovalLink(withRetry, ctx);
    expect(output.result.url).toBe(url);
    expect(output.result.nextStep).toContain('agentlink_get_approval');
    expect(output.result.nextStep).toContain('agentlink_accept_invite');
    expect([...(output.result.nextStep ?? '')].length).toBeLessThanOrEqual(500);
    expect(resultIsValid(output.result, origins)).toBe(true);
    expect(finalizeResult(output, origins).structured.code).toBeUndefined();
  });
});
