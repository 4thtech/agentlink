// IR UX2-d1 (Medium): `agentlink_accept_invite` asks the owner with core's one accept summary, the
// same text the local app's accept route and the CLI use, so one request (reused through findOpen)
// shows the same words on every surface: name, label and short owner fingerprint (04 §3.6 Accept
// step 2).
import { acceptInviteSummary, encodeInviteLink, type PendingContact } from '@4thtech-io/core';
import { encodeBase64url } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { acceptInviteHandler } from './accept-invite.js';
import type { ToolContext } from './context.js';

const hex = (n: number, pair: string): string => pair.repeat(n);

const CONTACT: PendingContact = {
  id: `0x${hex(20, '1a')}`,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' } as never,
  ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};

async function aLink(): Promise<string> {
  return encodeInviteLink({
    v: 1,
    inviteId: encodeBase64url(new Uint8Array(16).fill(1)),
    secret: encodeBase64url(new Uint8Array(32).fill(2)),
    card: {
      version: 1,
      agentEvm: `0x${hex(20, '1a')}`,
      agentNostr: `0x${hex(32, 'd4')}`,
      agentEnc: `0x${hex(32, '0e')}`,
      ownerEvm: `0x${hex(20, '2b')}`,
      ownerNostr: `0x${hex(32, 'c3')}`,
      ownerEnc: `0x${hex(32, '0f')}`,
      nameHash: `0x${hex(32, '11')}`,
      relaysHash: `0x${hex(32, '22')}`,
      issuedAt: 1760000000,
      expiresAt: 0,
      keyEpoch: 0,
    },
    cardSig: `0x${hex(64, '3c')}1b`,
    cardAgentSig: `0x${hex(64, '4d')}1c`,
    codeCommit: encodeBase64url(new Uint8Array(32).fill(3)),
    name: 'Marko',
    relays: ['wss://relay.example.org', 'wss://nos.example.net:7447/sub/path'],
    expiresAt: 1_800_000_000,
  } as never);
}

describe('the accept summary (IR UX2-d1 M)', () => {
  it('the tool asks with core acceptInviteSummary, which carries the owner fingerprint', async () => {
    const summaries: string[] = [];
    const context = {
      approvalNextStep: () => 'Approve it.',
      client: {
        invites: {
          check: () => Promise.resolve(CONTACT),
          decision: () => Promise.resolve('approval'),
          findOpenApproval: () => Promise.resolve(undefined),
          requestApproval: (_action: unknown, summary: string) => {
            summaries.push(summary);
            return Promise.resolve(`apr_${'A'.repeat(22)}`);
          },
        },
      },
    } as unknown as ToolContext;
    await acceptInviteHandler({ inviteUrl: await aLink() }, context);
    expect(summaries).toEqual([acceptInviteSummary(CONTACT)]);
    expect(summaries[0]).toContain('(owner AB12·CD34)');
  });
});
