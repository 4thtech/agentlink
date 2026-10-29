// W4-FILES-SAVE (S2; 04 §2.5.1 op table `file.save`; 08 §1 "Save a received file"; proposed, owner
// confirms at merge): the local owner action that saves one received file into the Inbox folder from
// the local app. Written from the spec text:
// - params are exactly `{agent, envelopeId, fileIndex}`; `params.agent` is the agent's `agentId` and
//   must equal the body's `agent`;
// - `envelopeId` is a 16-byte envelope ID (base64url without padding); `fileIndex` an integer from 0
//   to 15 (MAX_FILES_PER_PAYLOAD − 1). No name, folder or path is ever part of it;
// - it expires, with L(op) = 600 s; no envelope carries it.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  OWNER_ACTION_OPS,
  fileSaveActionSchema,
  ownerActionSchema,
  signedApprovalOpSchema,
  signedOwnerActionSchema,
} from './index.js';
import { expectReject, expectRoundTrip } from './testing/assert.js';
import { AGENT_EVM, CONTACT_A, OWNER_NOSTR, b64u, signed } from './testing/fixtures.js';

const NONCE = b64u(16, 'S');
const ENVELOPE = b64u(16, 'E');

const saveAction = (
  params: Record<string, unknown> = { agent: AGENT_EVM, envelopeId: ENVELOPE, fileIndex: 0 },
) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'file.save',
  params,
  nonce: NONCE,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

describe('file.save schema (W4-FILES-SAVE)', () => {
  it('is an owner-action op with L(op) = 600 s', () => {
    expect(OWNER_ACTION_OPS).toContain('file.save');
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['file.save']).toBe(600);
  });

  it('accepts exactly {agent, envelopeId, fileIndex}, in the union and signed', () => {
    expectRoundTrip(fileSaveActionSchema, saveAction());
    expectRoundTrip(fileSaveActionSchema, saveAction({ agent: AGENT_EVM, envelopeId: ENVELOPE, fileIndex: 15 }));
    expectRoundTrip(ownerActionSchema, saveAction());
    expectRoundTrip(signedOwnerActionSchema, signed(saveAction()));
  });

  it('refuses another agent in params, a path, a name or an extra key', () => {
    const base = { agent: AGENT_EVM, envelopeId: ENVELOPE, fileIndex: 0 };
    expectReject(fileSaveActionSchema, saveAction({ ...base, agent: CONTACT_A }));
    expectReject(fileSaveActionSchema, saveAction({ ...base, path: '/tmp/x' }));
    expectReject(fileSaveActionSchema, saveAction({ ...base, name: 'x.txt' }));
    expectReject(fileSaveActionSchema, saveAction({ envelopeId: ENVELOPE, fileIndex: 0 }));
  });

  it('refuses a malformed envelope ID or file index', () => {
    const base = { agent: AGENT_EVM, envelopeId: ENVELOPE, fileIndex: 0 };
    for (const envelopeId of ['', '../x', `${ENVELOPE}.00`, b64u(15, 'E'), b64u(32, 'E'), 7]) {
      expectReject(fileSaveActionSchema, saveAction({ ...base, envelopeId }));
    }
    for (const fileIndex of [-1, 16, 1.5, '0', null]) {
      expectReject(fileSaveActionSchema, saveAction({ ...base, fileIndex }));
    }
  });

  it('expires within L(op) and is never carried by an approval envelope', () => {
    expectReject(fileSaveActionSchema, { ...saveAction(), expiresAt: 0 });
    expectReject(signedApprovalOpSchema, signed(saveAction()));
  });
});
