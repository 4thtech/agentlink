// M1-36d-c: a guard for the 500 code point limit of `nextStep` (06 §2.5, toolTextSchema). Every
// nextStep builder is rendered at its worst case (longest agent name, port 65535, longest IDs, the
// `npx` command prefix, the longest tail) and must stay within the limit, so a copy edit that
// pushes one over fails here, not in a user's chat as a generic error.
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import { approvalNextStep } from '../approval/next-step.js';
import { NPX_PREFIX } from '../runtime/cli-prefix.js';
import type { ToolClient, ToolContext } from '@4thtech-io/mcp-tools/context.js';
import { PAY_PAGE } from '@4thtech-io/chain';
import { readdirSync } from 'node:fs';
import { acceptRetryStep, approvedNeedsIdStep } from '@4thtech-io/mcp-tools/invite-common.js';
import { needsCredits } from '@4thtech-io/mcp-tools/proofs-common.js';
import {
  RESULT_TEXT,
  finalizeResult,
  pendingApproval,
  resultIsValid,
  withApprovalLink,
  type HandlerOutput,
} from '@4thtech-io/mcp-tools/result.js';
import { SEND_TEXT } from '@4thtech-io/mcp-tools/send.js';
import { en } from '@4thtech-io/mcp-tools/strings/en.js';
import { approvalLinkNextStep } from './approval-ui.js';
import * as tool_accept_action from '@4thtech-io/mcp-tools/accept-action.js';
import * as tool_accept_invite from '@4thtech-io/mcp-tools/accept-invite.js';
import * as tool_acknowledge from '@4thtech-io/mcp-tools/acknowledge.js';
import * as tool_approval_wait from '@4thtech-io/mcp-tools/approval-wait.js';
import * as tool_cli_command from '@4thtech-io/mcp-tools/cli-command.js';
import * as tool_contacts from '@4thtech-io/mcp-tools/contacts.js';
import * as tool_context from '@4thtech-io/mcp-tools/context.js';
import * as tool_create_invite from '@4thtech-io/mcp-tools/create-invite.js';
import * as tool_export_proof_pack from '@4thtech-io/mcp-tools/export-proof-pack.js';
import * as tool_fetch_file from '@4thtech-io/mcp-tools/fetch-file.js';
import * as tool_files_common from '@4thtech-io/mcp-tools/files-common.js';
import * as tool_free_credits from '@4thtech-io/mcp-tools/free-credits.js';
import * as tool_get_approval from '@4thtech-io/mcp-tools/get-approval.js';
import * as tool_get_proof from '@4thtech-io/mcp-tools/get-proof.js';
import * as tool_inbox from '@4thtech-io/mcp-tools/inbox.js';
import * as tool_index from '@4thtech-io/mcp-tools';
import * as tool_input from '@4thtech-io/mcp-tools/input.js';
import * as tool_invite_common from '@4thtech-io/mcp-tools/invite-common.js';
import * as tool_list_contacts from '@4thtech-io/mcp-tools/list-contacts.js';
import * as tool_notarize from '@4thtech-io/mcp-tools/notarize.js';
import * as tool_proofs_common from '@4thtech-io/mcp-tools/proofs-common.js';
import * as tool_propose_terms from '@4thtech-io/mcp-tools/propose-terms.js';
import * as tool_registry from '@4thtech-io/mcp-tools/registry.js';
import * as tool_respond_to_terms from '@4thtech-io/mcp-tools/respond-to-terms.js';
import * as tool_result from '@4thtech-io/mcp-tools/result.js';
import * as tool_send from '@4thtech-io/mcp-tools/send.js';
import * as tool_status from '@4thtech-io/mcp-tools/status.js';
import * as tool_terms_common from '@4thtech-io/mcp-tools/terms-common.js';
import * as tool_text from '@4thtech-io/mcp-tools/text.js';
import * as tool_untrusted from '@4thtech-io/mcp-tools/untrusted.js';
import * as tool_verify_proof_pack from '@4thtech-io/mcp-tools/verify-proof-pack.js';
import * as approval_next_step from '../approval/next-step.js';
import * as approval_ui from './approval-ui.js';

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

// ---- Discovery: every exported *_TEXT sheet and every nextStep builder -----------------------------

type Exports = Record<string, unknown>;
const toolsDir = new URL('../../../../packages/mcp-tools/src/', import.meta.url);
const sourceFiles = (dir: URL): string[] =>
  readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
// Explicit list (no dynamic import: boundary rules forbid it). The guard below fails when a tool
// file is added without being listed here, so a new tool cannot be silently skipped.
const modules: Record<string, Exports> = {
  '../tools/accept-action.ts': tool_accept_action,
  '../tools/accept-invite.ts': tool_accept_invite,
  '../tools/acknowledge.ts': tool_acknowledge,
  '../tools/approval-wait.ts': tool_approval_wait,
  '../tools/cli-command.ts': tool_cli_command,
  '../tools/contacts.ts': tool_contacts,
  '../tools/context.ts': tool_context,
  '../tools/create-invite.ts': tool_create_invite,
  '../tools/export-proof-pack.ts': tool_export_proof_pack,
  '../tools/fetch-file.ts': tool_fetch_file,
  '../tools/files-common.ts': tool_files_common,
  '../tools/free-credits.ts': tool_free_credits,
  '../tools/get-approval.ts': tool_get_approval,
  '../tools/get-proof.ts': tool_get_proof,
  '../tools/inbox.ts': tool_inbox,
  '../tools/index.ts': tool_index,
  '../tools/input.ts': tool_input,
  '../tools/invite-common.ts': tool_invite_common,
  '../tools/list-contacts.ts': tool_list_contacts,
  '../tools/notarize.ts': tool_notarize,
  '../tools/proofs-common.ts': tool_proofs_common,
  '../tools/propose-terms.ts': tool_propose_terms,
  '../tools/registry.ts': tool_registry,
  '../tools/respond-to-terms.ts': tool_respond_to_terms,
  '../tools/result.ts': tool_result,
  '../tools/send.ts': tool_send,
  '../tools/status.ts': tool_status,
  '../tools/terms-common.ts': tool_terms_common,
  '../tools/text.ts': tool_text,
  '../tools/untrusted.ts': tool_untrusted,
  '../tools/verify-proof-pack.ts': tool_verify_proof_pack,
  '../approval/next-step.ts': approval_next_step,
  './approval-ui.ts': approval_ui,
};

describe('the explicit module list', () => {
  it('covers every tool source file', () => {
    const listed = Object.keys(modules)
      .filter((k) => k.startsWith('../tools/'))
      .map((k) => k.slice('../tools/'.length))
      .sort();
    expect(listed).toEqual([...sourceFiles(toolsDir)].sort());
  });
});

/** Every exported `*_TEXT` object, plus the copy sheet `en`. */
const sheets: Record<string, Record<string, unknown>> = { en };
for (const [file, exports] of Object.entries(modules)) {
  for (const [name, value] of Object.entries(exports)) {
    if (/_TEXT$/.test(name) && typeof value === 'object' && value !== null) {
      sheets[`${file}#${name}`] = value as Record<string, unknown>;
    }
  }
}
/** Every string in a sheet, recursing into nested objects. */
function strings(value: unknown, path: string): (readonly [string, string])[] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => strings(inner, `${path}.${key}`));
}
const filler = (key: string): string => (/approvalId/i.test(key) ? APPROVAL : ENVELOPE);

describe('every fixed nextStep and hint text stays within 500 code points', () => {
  const entries = Object.entries(sheets).flatMap(([sheet, texts]) => strings(texts, sheet));

  it('discovers all the text sheets', () => {
    const names = Object.keys(sheets).map((s) => s.split('#')[1]);
    for (const expected of [
      'ACK_TEXT',
      'INBOX_TEXT',
      'FETCH_FILE_TEXT',
      'VERIFY_TEXT',
      'EXPORT_TEXT',
      'GET_PROOF_TEXT',
      'FILE_TEXT',
      'INVITE_TEXT',
      'PROOF_TEXT',
      'RESULT_TEXT',
      'SEND_TEXT',
      'TERMS_TEXT',
      'TOOL_TEXT',
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(entries.length).toBeGreaterThan(40);
  });

  it.each(entries)('%s', (_name, text) => {
    // Longest fill for any {placeholder}: an envelope ID or an approval ID, whichever is longer.
    const filled = text.replace(/\{(\w+)\}/g, (_m, key: string) => filler(key));
    expect(len(filled)).toBeLessThanOrEqual(LIMIT);
  });

  // Text builders inside a sheet (for example INBOX_TEXT.someMessages(count)): rendered with the
  // largest count; a builder this test cannot render fails, so a new one is never skipped.
  const builders = Object.entries(sheets).flatMap(([sheet, texts]) =>
    Object.entries(texts)
      .filter(([, value]) => typeof value === 'function' && value.length === 1)
      .map(
        ([key, value]) => [`${sheet}.${key}`, value as (...args: unknown[]) => unknown] as const,
      ),
  );
  it('discovers one-argument text builders', () => expect(builders.length).toBeGreaterThan(0));
  it.each(builders)('builder %s', (name, fn) => {
    const rendered = fn(Number.MAX_SAFE_INTEGER);
    expect(typeof rendered, `${name}: no worst-case renderer`).toBe('string');
    expect(len(rendered as string)).toBeLessThanOrEqual(LIMIT);
  });
});

/** Worst-case renderers for the exported nextStep builder functions and the composed nextSteps. */
const RENDERERS: Record<string, () => string> = {
  acceptRetryStep: () => acceptRetryStep(APPROVAL),
  approvedNeedsIdStep: () => approvedNeedsIdStep(APPROVAL),
  approvalNextStep: () => approvalNextStep(APPROVAL, LONG_NAME, NPX_PREFIX),
  approvalLinkNextStep: () => approvalLinkNextStep(APPROVAL, URL_, LONG_NAME, NPX_PREFIX),
};

describe('nextStep builders', () => {
  const found = Object.entries(modules).flatMap(([file, exports]) =>
    Object.entries(exports)
      .filter(([name, value]) => typeof value === 'function' && /(NextStep|Step)$/.test(name))
      .map(([name]) => `${file}#${name}`),
  );

  it('finds the builders', () => {
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(RENDERERS).length);
  });

  it.each(found)('%s has a worst-case renderer within the limit', (id) => {
    const name = id.split('#')[1] ?? '';
    const render = RENDERERS[name];
    expect(render, `${id}: add a worst-case renderer to RENDERERS`).toBeDefined();
    expect(len(render?.())).toBeLessThanOrEqual(LIMIT);
  });

  const agentId = `0x${'f'.repeat(40)}`;
  const livePay = { ...PAY_PAGE, live: true };
  it.each([
    ['fee and shortfall', { feeUsd: '0.000001', usd: '99999999.99' }],
    ['fee and shortfall, small fee', { feeUsd: '0.01', usd: '4.99' }],
    ['no amount', {}],
    ['no route', undefined],
  ] as const)('needs_credits (%s) with the link, covers and disclosure', (_n, route) => {
    const out = needsCredits(agentId, route, {}, livePay);
    expect(len(out.result.nextStep)).toBeLessThanOrEqual(LIMIT);
    expect(len(out.result.summary)).toBeLessThanOrEqual(LIMIT);
    expect(resultIsValid(out.result, [])).toBe(true);
  });

  it('inbox nextSteps joined (receipt, request and incomplete) fit', () => {
    const joined = [
      en['chat.inbox.receiptRequestNextStep'],
      en['chat.inbox.requestNextStep'],
      en['chat.inbox.incompleteNextStep'],
    ].join(' ');
    expect(len(joined)).toBeLessThanOrEqual(LIMIT);
  });
});
