// W4-SHORT-INVITE (04 §3.6.2; 06 §2.1): `agentlink_accept_invite` with a short link. The tool
// resolves the link once at entry and uses the resolved invite for step 1, the approval action and
// the start, so the approval keeps the resolved invite sealed and every surface builds one action.
// A gone object and an unreachable drop are fixed results with no link in them.
import {
  CoreError,
  INVITE_LINK_PREFIX,
  encodeInviteLink,
  type PendingContact,
} from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { acceptInviteHandler } from './accept-invite.js';
import type { InviteTools, ToolContext } from './context.js';
import { encodeBase64url } from '@4thtech-io/crypto';

const hex = (n: number, pair: string): string => pair.repeat(n);

/** A schema-valid long link (signatures are not checked here: core's step 1 is the fake). */
const aLink = (): Promise<string> =>
  encodeInviteLink({
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
    relays: ['wss://relay.example.org'],
    expiresAt: 1_800_000_000,
  } as never);

const SHORT = `${INVITE_LINK_PREFIX}2.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`;

const CONTACT: PendingContact = {
  id: `0x${'3d'.repeat(20)}`,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' } as never,
  ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};

function tools(long: string, over: Partial<InviteTools> = {}) {
  const seen: string[] = [];
  const resolved: string[] = [];
  const invites: InviteTools = {
    resolve: (link) => {
      resolved.push(link);
      return Promise.resolve(long);
    },
    create: () => Promise.reject(new Error('unused')),
    check: (link) => {
      seen.push(`check:${link}`);
      return Promise.resolve(CONTACT);
    },
    decision: () => Promise.resolve('allow'),
    requestApproval: () => Promise.resolve('apr_x'),
    findOpenApproval: () => Promise.resolve(undefined),
    useApproval: () => Promise.reject(new Error('unused')),
    start: (link) => {
      seen.push(`start:${link}`);
      return Promise.resolve(CONTACT);
    },
    publish: () => Promise.resolve(true),
    ...over,
  };
  const context = { client: { invites } } as unknown as ToolContext;
  return { context, seen, resolved };
}

describe('agentlink_accept_invite with a short link (D-139)', () => {
  it('resolves once and uses the resolved invite for every step', async () => {
    const long = await aLink();
    const t = tools(long);
    const out = await acceptInviteHandler({ inviteUrl: SHORT }, t.context);
    expect(JSON.stringify(out)).not.toContain('2.AAECAwQ');
    expect(t.resolved).toEqual([SHORT]);
    expect(t.seen).toEqual([`check:${long}`, `start:${long}`]);
  });

  it('a gone invite and an unreachable drop are fixed results', async () => {
    for (const [code, want] of [
      ['invite_unavailable', 'INVITE_UNAVAILABLE'],
      ['invite_fetch_failed', 'INVITE_FETCH_FAILED'],
    ] as const) {
      const t = tools('', { resolve: () => Promise.reject(new CoreError(code, 'x')) });
      const out = await acceptInviteHandler({ inviteUrl: SHORT }, t.context);
      expect(JSON.stringify(out)).toContain(want);
      expect(JSON.stringify(out)).not.toContain(SHORT);
      expect(t.seen).toEqual([]);
    }
  });
});
