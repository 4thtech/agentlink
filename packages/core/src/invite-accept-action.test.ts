// UX2-d1: the accept-invite approval action, its summary and the invite share text live in core, so
// the MCP tool, the CLI `accept --approval` and the local app's accept route build one action (one
// approval serves every surface) and one share text (06 §2.1, 11 §6.1 J7).
import { encodeBase64url } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { Invite } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import {
  acceptInviteAction,
  acceptInviteApprovalSummary,
  acceptInviteSummary,
  inviteShareText,
} from './invite-accept-action.js';
import type { PendingContact } from './pairing.js';
import { INVITE_LINK_PREFIX, encodeInviteLink } from './invite-link.js';
import { makeAgent } from './testing/envelopes.js';
import { FakeClock, RELAYS, passphrase, seed } from './testing/fixtures.js';

async function aLink(): Promise<{ link: string; invite: Invite }> {
  const clock = new FakeClock();
  const owner = new MemoryOwnerKeyStore(seed(211), passphrase());
  const agent = await makeAgent(clock, new MemoryKeyStore(seed(11)), owner, 'Marko’s agent');
  const signed = await agent.client.identity.signedCard();
  const invite: Invite = {
    v: 1,
    inviteId: encodeBase64url(new Uint8Array(16).fill(7)),
    secret: encodeBase64url(new Uint8Array(32).fill(8)),
    card: signed.card as unknown as Invite['card'],
    cardSig: signed.cardSig,
    cardAgentSig: signed.cardAgentSig,
    codeCommit: encodeBase64url(new Uint8Array(32).fill(9)),
    name: signed.name,
    relays: [...RELAYS],
    expiresAt: 1_800_000_000,
  };
  return { link: await encodeInviteLink(invite), invite };
}

describe('acceptInviteAction (UX2-d1, moved from mcp-tools)', () => {
  it('names the tool, the full link, the invite and the counterparty', async () => {
    const { link, invite } = await aLink();
    const action = await acceptInviteAction(link);
    expect(action).toEqual({
      tool: 'agentlink_accept_invite',
      args: { inviteUrl: link },
      context: {
        triggers: ['contacts.acceptInvites'],
        inviteId: invite.inviteId,
        counterparty: {
          agentId: invite.card.agentEvm,
          ownerKey: invite.card.ownerNostr.slice(2),
        },
      },
    });
  });

  it('builds one action for the full link and the bare payload', async () => {
    const { link } = await aLink();
    const bare = link.slice(INVITE_LINK_PREFIX.length);
    expect(await acceptInviteAction(bare)).toEqual(await acceptInviteAction(link));
  });

  it('refuses a link that does not decode, with the codec error and no link in it', async () => {
    const bad = `${INVITE_LINK_PREFIX}AAAA`;
    const error = await acceptInviteAction(bad).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('AAAA');
  });

  it('the approval summary is fixed text around the name-rule name', () => {
    expect(acceptInviteApprovalSummary('“Marko” (self-declared)')).toBe(
      'Accept an invite from “Marko” (self-declared)',
    );
  });
});

describe('inviteShareText (UX2-d1, 11 §6.1 J7)', () => {
  it('is the fixed template with the expiry date (UTC) and the link', () => {
    const link = `${INVITE_LINK_PREFIX}abc`;
    // 2026-11-04T10:00:00Z
    expect(inviteShareText(link, 1_793_786_400)).toBe(
      `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until 4 Nov 2026: ${link}`,
    );
  });
});

describe('acceptInviteSummary (IR UX2-d1 M: 04 §3.6 Accept step 2)', () => {
  const contact = (name: string): PendingContact => ({
    id: `0x${'3d'.repeat(20)}`,
    display: { name, label: 'self-declared', nameSource: 'counterparty' } as never,
    ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
    pairing: 'pending',
    safetyCodeChecked: false,
  });

  it('names the contact under the name rule, its label and the short owner fingerprint', () => {
    expect(acceptInviteSummary(contact('Marko'))).toBe(
      'Accept an invite from “Marko” (self-declared) (owner AB12·CD34)',
    );
    expect(acceptInviteSummary(contact('Marko'))).toContain('AB12·CD34');
  });

  it('is one line: control characters and line breaks become spaces', () => {
    const text = acceptInviteSummary(contact('Mar\nko\u2028x\u0007'));
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(text).toContain('(owner AB12·CD34)');
  });
});
