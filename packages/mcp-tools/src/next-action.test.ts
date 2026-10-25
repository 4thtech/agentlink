// M1-36d (UX audit F5a, F6, F7, F12, F18; 11 §5): every tool result names one plain next action.
import { CoreError } from '@4thtech-io/core';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import type { ToolClient, ToolContext } from './context.js';
import { NPX_COMMAND } from './cli-command.js';
import { FILE_TEXT, attachRefusal } from './files-common.js';
import { INVITE_TEXT, inviteFailure } from './invite-common.js';
import { pendingApproval } from './result.js';
import { en } from './strings/en.js';

const APPROVAL = 'apr_AAAAAAAAAAAAAAAAAAAAAA';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client: {} as ToolClient,
    clock: () => 1_760_600_000,
    logger: createLogger({ level: 'debug', sink: () => undefined }),
    agentName: 'default',
    approvalNextStep: (id) =>
      `Tell the user: Approval needed. Run agentlink approve ${id}. After they approve, call the same tool again with approvalId.`,
    urlOrigins: [],
    ...overrides,
  };
}

const BANNED =
  /\b(wallets?|gas|seed phrases?|transactions?|chains?|address(es)?|hash(es)?|signing)\b/i;
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

describe('pending_approval points at agentlink_get_approval (F5a)', () => {
  it('names agentlink_get_approval in the M1a nextStep', () => {
    const out = pendingApproval(context(), APPROVAL, 'This needs your approval.');
    expect(out.result.nextStep).toContain('agentlink_get_approval');
  });

  it('keeps the context nextStep as its prefix, so the link can replace it (L-1)', () => {
    const ctx = context();
    const out = pendingApproval(ctx, APPROVAL, 'This needs your approval.');
    expect(out.result.nextStep?.startsWith(ctx.approvalNextStep(APPROVAL))).toBe(true);
  });

  it('the copy sheet nextStep names it too', () => {
    expect(en['chat.status.pending_approval.nextStep']).toContain('agentlink_get_approval');
  });
});

describe('the folder-not-allowed results name the exact step (F12)', () => {
  it('no_folder and outside_folder name the terminal command', () => {
    for (const reason of ['no_folder', 'outside_folder'] as const) {
      const out = attachRefusal(reason);
      expect(out.result.nextStep, reason).toContain('agentlink policy allow-folder');
      expect(out.result.nextStep, reason).toMatch(/terminal/);
    }
    expect(FILE_TEXT.noFolderNextStep).not.toMatch(/AgentLink rules/);
  });
});

describe('no folder yet names the Send folder setup (M1-36b-2-c)', () => {
  it('names the exact owner-terminal command, with the npx prefix', () => {
    const out = attachRefusal('no_folder');
    expect(out.result.code).toBe('NO_ALLOWED_FOLDER');
    expect(out.result.nextStep).toContain(`${NPX_COMMAND} policy allow-send-folder`);
    expect(out.result.nextStep).toMatch(/terminal they opened themselves/);
    expect(out.result.nextStep).toContain('~/AgentLink/Send');
  });
});

describe('the file path hints are exact (L-2)', () => {
  it('say <path> and the --agent hint for allow-folder', () => {
    for (const text of [FILE_TEXT.noFolderNextStep, FILE_TEXT.outsideFolderNextStep]) {
      expect(text).toContain('agentlink policy allow-folder <path>');
      expect(text).toContain('--agent <name>');
      expect(text).not.toContain('<folder>');
    }
  });
});

describe('invite and pairing results (F6, F18)', () => {
  it('never point at an unavailable command', () => {
    for (const text of [
      INVITE_TEXT.acceptedNextStep,
      INVITE_TEXT.createdNext,
      INVITE_TEXT.accepted,
      INVITE_TEXT.acceptedOffline,
      en['chat.status.ok.acceptedInvite'],
    ]) {
      expect(text).not.toContain('--verify');
    }
  });

  it('mention the safety code once per pairing side, not twice', () => {
    const accept = [INVITE_TEXT.accepted, INVITE_TEXT.acceptedNextStep].join(' ');
    expect(count(accept, /safety code/gi)).toBeLessThanOrEqual(1);
    expect(count(INVITE_TEXT.createdNext, /safety code/gi)).toBeLessThanOrEqual(1);
    expect(count(en['chat.status.ok.acceptedInvite'], /safety code/gi)).toBeLessThanOrEqual(1);
  });

  it('say what to do next', () => {
    expect(INVITE_TEXT.acceptedNextStep).toMatch(/^Tell the user/);
  });
});

describe('copy points only at commands that exist (F7)', () => {
  it('has no keystore flag or ui command', () => {
    expect(en['chat.status.needs_setup.keychain']).not.toContain('--keystore');
    expect(en['chat.status.needs_setup.keychain']).toContain('agentlink doctor');
    expect(en['local.linkExpired']).not.toContain('agentlink ui');
  });
});

describe('invite and file next steps stay plain (11 §5)', () => {
  it('use no banned word', () => {
    const texts = [
      ...Object.values(INVITE_TEXT),
      ...Object.values(FILE_TEXT),
      inviteFailure(new CoreError('invite_invalid', 'x'))?.result.nextStep ?? '',
    ];
    for (const text of texts) expect(text).not.toMatch(BANNED);
  });
});
