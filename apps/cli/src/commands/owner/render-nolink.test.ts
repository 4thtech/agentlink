// M1-11a-ux-c: the terminal approve card never prints a link or invite token; it shows who, what
// and when in plain words, like the approval page does (AGENTS.md: never print share links/URLs).
import type { AgentLinkClient } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import type { PendingRequest } from './pending.js';
import { cardFacts, cardLines } from './render.js';

const TOKEN = 'SECRETINVITETOKEN123';
const URLS = [`https://agentlink.4thtech.io/i#${TOKEN}`, `agentlink://i#${TOKEN}`];

const client = {
  contacts: { get: () => Promise.reject(new Error('unknown')) },
  pairing: { acceptInvite: () => Promise.reject(new Error('bad')) },
} as unknown as AgentLinkClient;

const requestFor = (inviteUrl: string): PendingRequest =>
  ({
    approvalId: `ap_${'a'.repeat(20)}`,
    expiresAt: 1_800_000_000,
    action: {
      tool: 'agentlink_accept_invite',
      args: { inviteUrl },
      context: { triggers: ['contacts.acceptInvites'], inviteId: 'x' },
    },
  }) as unknown as PendingRequest;

describe('approve card shows no link (M1-11a-ux-c)', () => {
  for (const url of URLS) {
    it(`omits ${url.split(':')[0]} invite links but keeps who, what, when`, async () => {
      const request = requestFor(url);
      const facts = await cardFacts(client, request);
      const text = cardLines(request, facts).join('\n');
      expect(text).not.toMatch(/https?:\/\//i);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('inviteUrl');
      expect(text).toContain('Who:');
      expect(text).toContain('What:');
      expect(text).toContain('Expires:  ');
      expect(text).toContain(facts.headline);
    });
  }
});
