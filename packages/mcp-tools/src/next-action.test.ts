// M1-36d (UX audit F5a, F6, F7, F12, F18; 11 §5): every tool result names one plain next action.
import { CoreError } from '@4thtech-io/core';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import type { ToolClient, ToolContext } from './context.js';
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

describe('the folder-not-allowed results point to the app first (REL051-A5)', () => {
  it('no_folder names Allow Send folder and outside_folder names Allow a folder, in the app', () => {
    for (const [reason, control] of [
      ['no_folder', 'Allow Send folder'],
      ['outside_folder', 'Allow a folder'],
    ] as const) {
      const out = attachRefusal(reason);
      const step = out.result.nextStep ?? '';
      expect(out.result.status, reason).toBe('needs_setup');
      expect(step, reason).toContain('AgentLink app');
      expect(step, reason).toContain(control);
      expect(step.length, reason).toBeLessThanOrEqual(500);
    }
    expect(FILE_TEXT.noFolderNextStep).not.toMatch(/AgentLink rules/);
  });
  it('outside_folder keeps the terminal as the fallback, after the app', () => {
    const step = attachRefusal('outside_folder').result.nextStep ?? '';
    expect(step).toContain('agentlink policy allow-folder');
    expect(step).toMatch(/terminal they opened themselves/);
    expect(step.indexOf('Allow a folder')).toBeLessThan(step.indexOf('terminal'));
  });
  it('never allows the folder itself and uses plain words (11 §5)', () => {
    for (const text of [FILE_TEXT.noFolderNextStep, FILE_TEXT.outsideFolderNextStep]) {
      expect(text).toContain("You can't allow it for them");
      expect(text).not.toMatch(/wallet|gas|seed phrase|transaction/i);
    }
  });
});

describe('ATT-ALLOW-LINK: no folder yet names the Send folder in the app, never a terminal command', () => {
  it('names Home and the Send folder, with no command, backtick or terminal', () => {
    const out = attachRefusal('no_folder');
    expect(out.result.code).toBe('NO_ALLOWED_FOLDER');
    const step = out.result.nextStep ?? '';
    expect(step).toContain('Send folder');
    expect(step).toContain('Home');
    expect(step).not.toMatch(
      /`|terminal|npx|policy allow|--agent|\bagentlink (policy|approve|doctor|init|owner|ui)\b/i,
    );
  });
});

describe('the file path hints are exact (L-2)', () => {
  it('say <path> and the --agent hint for allow-folder', () => {
    const text = FILE_TEXT.outsideFolderNextStep;
    expect(text).toContain('agentlink policy allow-folder <path>');
    expect(text).toContain('--agent <name>');
    expect(text).not.toContain('<folder>');
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

  it('mention the 12 digits once per pairing side, not twice', () => {
    const accept = [INVITE_TEXT.accepted, INVITE_TEXT.acceptedNextStep].join(' ');
    expect(count(accept, /Contact check/gi)).toBeLessThanOrEqual(1);
    expect(count(INVITE_TEXT.createdNext, /Contact check/gi)).toBeLessThanOrEqual(1);
    expect(count(en['chat.status.ok.acceptedInvite'], /Contact check/gi)).toBeLessThanOrEqual(1);
  });

  it('say what to do next', () => {
    expect(INVITE_TEXT.acceptedNextStep).toMatch(/^Tell the user/);
  });
});

describe('copy points only at commands that exist (F7)', () => {
  it('has no keystore flag or ui command', () => {
    expect(en['chat.status.needs_setup.keychain']).not.toContain('--keystore');
    expect(en['chat.status.needs_setup.keychain']).not.toContain('npx');
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
