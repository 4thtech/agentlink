// U3-d (D-138, U3-spec-04; 04 §2.5.1 op table; 08 §1 "Signed local owner actions"; proposed, owner
// confirms at merge): the local owner actions `agent.label`, `app.connect` and `app.disconnect`.
// Written from the spec text:
// - `agent.label` params are exactly `{agent, label}`; `app.connect` and `app.disconnect` params are
//   exactly `{app, agent, changeId}`;
// - `params.agent` is the agent's `agentId` (`0x` + 40 lowercase hex) and must equal the body's
//   `agent`; anything else is refused;
// - `label` is 1 to 32 code points (that it is its own restricted form is the core's rule,
//   `label_invalid`); `app` is an id from the fixed harness table (06 §7); `changeId` 64 lowercase
//   hex;
// - each expires, with L(op) = 600 s; no envelope carries them.
import { describe, expect, it } from 'vitest';
import {
  AI_APP_IDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  agentLabelActionSchema,
  appConnectActionSchema,
  appDisconnectActionSchema,
  ownerActionSchema,
  signedAgentLabelSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, SHA, b64u, signed } from './testing/fixtures.js';

const NONCE = b64u(16, 'L');

const labelAction = (params: Record<string, unknown> = { agent: AGENT_EVM, label: 'Work agent' }) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'agent.label',
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

const appAction = (
  op: 'app.connect' | 'app.disconnect',
  params: Record<string, unknown> = { app: 'claude-desktop', agent: AGENT_EVM, changeId: SHA },
) => ({ ...labelAction(), op, params });

describe('agent.label, app.connect and app.disconnect schemas (U3-d)', () => {
  it('are owner-action ops with L(op) = 600 s', () => {
    for (const op of ['agent.label', 'app.connect', 'app.disconnect'] as const) {
      expect(OWNER_ACTION_OPS).toContain(op);
      expect(OWNER_ACTION_MAX_LIFETIME_SECONDS[op]).toBe(600);
    }
  });

  it('fixes the AI app ids of the 06 §7 harness table', () => {
    expect([...AI_APP_IDS].sort()).toEqual(
      [
        'antigravity',
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'gemini-cli',
        'opencode',
        'windsurf',
      ].sort(),
    );
  });

  it('accept the exact forms', () => {
    for (const body of [
      labelAction(),
      labelAction({ agent: AGENT_EVM, label: 'a'.repeat(32) }),
      labelAction({ agent: AGENT_EVM, label: 'Ana Kovač' }),
      appAction('app.connect'),
      appAction('app.disconnect'),
      appAction('app.connect', { app: 'codex', agent: AGENT_EVM, changeId: SHA }),
    ]) {
      expectRoundTrip(ownerActionSchema, body);
      expectRoundTrip(signedOwnerActionSchema, signed(body));
    }
    expectRoundTrip(agentLabelActionSchema, labelAction());
    expectRoundTrip(signedAgentLabelSchema, signed(labelAction()));
    expectRoundTrip(appConnectActionSchema, appAction('app.connect'));
    expectRoundTrip(appDisconnectActionSchema, appAction('app.disconnect'));
  });

  it('refuse a params.agent that is not the body agent', () => {
    for (const body of [
      labelAction({ agent: CONTACT_A, label: 'Work agent' }),
      appAction('app.connect', { app: 'codex', agent: CONTACT_A, changeId: SHA }),
      appAction('app.disconnect', { app: 'codex', agent: CONTACT_A, changeId: SHA }),
    ]) {
      expectReject(ownerActionSchema, body);
      expectReject(signedOwnerActionSchema, signed(body));
    }
  });

  it('reject other keys, spellings, sizes and the other op params', () => {
    const upper = '0x' + '1A'.repeat(20);
    for (const body of [
      labelAction({ agent: AGENT_EVM }),
      labelAction({ label: 'Work' }),
      labelAction({ agent: AGENT_EVM, label: '' }),
      labelAction({ agent: AGENT_EVM, label: 'a'.repeat(33) }),
      labelAction({ agent: AGENT_EVM, label: 7 }),
      labelAction({ agent: upper, label: 'Work' }),
      labelAction({ agent: AGENT_EVM, label: 'Work', name: 'work' }),
      labelAction({ agent: AGENT_EVM, label: 'Work', generation: 3 }),
      { ...labelAction(), expiresAt: 0 },
      { ...labelAction(), expiresAt: 1760000000 },
      appAction('app.connect', { app: 'vscode', agent: AGENT_EVM, changeId: SHA }),
      appAction('app.connect', { app: 'codex', agent: AGENT_EVM, changeId: SHA.toUpperCase() }),
      appAction('app.connect', { app: 'codex', agent: AGENT_EVM, changeId: SHA.slice(2) }),
      appAction('app.connect', { app: 'codex', agent: AGENT_EVM }),
      appAction('app.connect', { app: 'codex', agent: AGENT_EVM, changeId: SHA, path: '/x' }),
      appAction('app.disconnect', { agent: AGENT_EVM, label: 'Work' }),
      { ...appAction('app.connect'), op: 'agent.label' },
    ]) {
      expectReject(ownerActionSchema, body);
      expectReject(signedOwnerActionSchema, signed(body));
    }
  });

  it('no envelope carries them (local owner surfaces only)', () => {
    expectReject(signedApprovalOpSchema, signed(labelAction()));
    expectReject(signedApprovalOpSchema, signed(appAction('app.connect')));
    expectReject(signedApprovalOpSchema, signed(appAction('app.disconnect')));
  });
});
