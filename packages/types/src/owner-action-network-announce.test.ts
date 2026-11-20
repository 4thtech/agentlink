// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 04 §2.5.1 op table `network.announce`; 07 §4.3 "Privacy";
// proposed, owner confirms at merge): the owner action that turns "Don't also announce on the default
// servers" on (`announceDefault: false`) or off (`true`) without changing the list. Written from the
// spec text:
// - params are exactly `{agent, announceDefault}`; `params.agent` is the agent's `agentId` and must
//   equal the body's `agent`; `announceDefault` is a boolean, never a list, a server or a URL;
// - it expires, with L(op) = 600 s; no envelope carries it.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  networkAnnounceActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const NONCE = b64u(16, 'N');

const announceAction = (
  params: Record<string, unknown> = { agent: AGENT_EVM, announceDefault: false },
) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'network.announce',
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

describe('network.announce schema (NET-ANNOUNCE-OPTOUT)', () => {
  it('is an owner-action op with L(op) = 600 s', () => {
    expect(OWNER_ACTION_OPS).toContain('network.announce');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['network.announce']).toBe(600);
  });

  it('accepts exactly {agent, announceDefault}, both values, in the union and signed', () => {
    expectRoundTrip(networkAnnounceActionSchema, announceAction());
    expectRoundTrip(
      networkAnnounceActionSchema,
      announceAction({ agent: AGENT_EVM, announceDefault: true }),
    );
    expectRoundTrip(ownerActionSchema, announceAction());
    expectRoundTrip(signedOwnerActionSchema, signed(announceAction()));
  });

  it('refuses another agent, a non-boolean, a server list or an extra key', () => {
    const base = { agent: AGENT_EVM, announceDefault: false };
    expectReject(networkAnnounceActionSchema, announceAction({ ...base, agent: CONTACT_A }));
    for (const announceDefault of [0, 1, 'false', null, undefined]) {
      expectReject(networkAnnounceActionSchema, announceAction({ ...base, announceDefault }));
    }
    expectReject(
      networkAnnounceActionSchema,
      announceAction({ ...base, servers: ['wss://one.example.org'] }),
    );
    expectReject(networkAnnounceActionSchema, announceAction({ announceDefault: false }));
  });

  it('expires and is never carried by an approval envelope', () => {
    expectReject(networkAnnounceActionSchema, { ...announceAction(), expiresAt: 0 });
    expectReject(signedApprovalOpSchema, signed(announceAction()));
  });
});
