// UX2-d1: the local app's create-invite route answers core's `inviteShareText`; the MCP tool
// answers its own strings table. They must stay the same text (06 §2.1, 11 §6.1 J7).
import { INVITE_LINK_PREFIX, inviteShareText } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import * as acceptAction from './accept-action.js';
import { copy, formatDate } from './strings/index.js';

describe('invite share text (UX2-d1)', () => {
  it('core and the MCP strings table give the same text', () => {
    const inviteUrl = `${INVITE_LINK_PREFIX}abc_-`;
    for (const at of [1_793_786_400, 1_760_600_000, 1_800_000_000]) {
      const date = formatDate(new Date(at * 1000));
      expect(inviteShareText(inviteUrl, at)).toBe(
        copy('chat.status.ok.inviteShare', { date, inviteUrl }),
      );
    }
  });

  it('accept-action.js still exports the builder and the summary (now from core)', () => {
    expect(typeof acceptAction.acceptInviteAction).toBe('function');
    expect(acceptAction.acceptInviteApprovalSummary('x')).toBe('Accept an invite from x');
  });
});
