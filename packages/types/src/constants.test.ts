// Constants: each value is cited from the spec, so a drift from the spec text fails here.
import { describe, expect, it } from 'vitest';
import {
  AGENT_CARD_EIP712_DOMAIN,
  AGENT_CARD_EIP712_TYPES,
  ALF1_HEADER_BYTES,
  AEAD_TAG_BYTES,
  APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS,
  APPROVAL_BATCH_MAX_ITEMS,
  APPROVAL_BATCH_MIN_ITEMS,
  APPROVAL_DECISIONS,
  APPROVAL_ID_PREFIX,
  APPROVAL_STATUSES,
  APPROVAL_SUMMARY_MAX_CHARS,
  APPROVAL_TOOL_NAMES,
  APPROVAL_TTL_SECONDS,
  BUDGET_WINDOW_SECONDS,
  BYTE_LENGTHS,
  CLOCK_SKEW_SECONDS,
  COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS,
  LATER_OP_DEFAULT_LIFETIME_SECONDS,
  MAX_OWNER_ACTION_LIFETIME_SECONDS,
  NONCE_RETENTION_SECONDS,
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  CORE_ONLY_PAYLOAD_TYPES,
  FEE_TYPES,
  FILE_LINK_MAX_EXPIRY_DAYS,
  FILE_PAYLOAD_TYPES,
  INVITE_DEFAULT_EXPIRY_DAYS,
  MAX_ENVELOPE_BYTES,
  MAX_INLINE_CIPHERTEXT_BYTES,
  MAX_INLINE_FILE_BYTES,
  MAX_RECIPIENTS,
  MAX_RELAYS,
  MIN_RELAYS,
  MCP_STATUSES,
  MCP_TOOL_NAMES,
  MIN_RECIPIENTS,
  OWNER_ACTION_OPS,
  OWNER_CHANNEL_PAYLOAD_TYPES,
  PAYLOAD_TYPES,
  POLICY_DEFAULTS_SPEC,
  POLICY_PROTOCOL_LIMITS,
  RECEIPT_TYPES,
  RECORD_KINDS,
  REVOKE_REASONS,
  SEND_TOOL_PAYLOAD_TYPES,
  SENDABLE_PAYLOAD_TYPES,
  TERMS_PAYLOAD_TYPES,
  packageName,
} from './index.js';
import { agentCard } from './testing/fixtures.js';

describe('constants (04, 05, 06)', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@agentlink/types');
  });

  it('has exactly the 17 payload types of 04 §3.4, in spec order', () => {
    expect(PAYLOAD_TYPES).toEqual([
      'text',
      'request',
      'offer',
      'accept',
      'reject',
      'delivery',
      'note',
      'file',
      'ack',
      'handshake',
      'handshake-ack',
      'proof',
      'approval',
      'approval-request',
      'policy',
      'card-update',
      'revoke',
    ]);
    expect(new Set(PAYLOAD_TYPES).size).toBe(17);
  });

  it('limits tool-sendable types to 02 F-22, split between send and the terms tools (06 §2.2, §2.2a)', () => {
    expect([...SENDABLE_PAYLOAD_TYPES].sort()).toEqual(
      ['text', 'note', 'request', 'delivery', 'offer', 'accept', 'reject'].sort(),
    );
    expect(SEND_TOOL_PAYLOAD_TYPES).toEqual(['text', 'note', 'request', 'delivery']);
    expect(TERMS_PAYLOAD_TYPES).toEqual(['offer', 'accept', 'reject']);
  });

  it('lists the owner-channel types and the types no MCP tool may create (04 §3.4.1)', () => {
    expect([...OWNER_CHANNEL_PAYLOAD_TYPES].sort()).toEqual(
      ['approval', 'approval-request', 'policy'].sort(),
    );
    expect([...CORE_ONLY_PAYLOAD_TYPES].sort()).toEqual(
      [
        'approval-request',
        'approval',
        'policy',
        'revoke',
        'card-update',
        'handshake',
        'handshake-ack',
      ].sort(),
    );
    for (const t of CORE_ONLY_PAYLOAD_TYPES) expect(SENDABLE_PAYLOAD_TYPES).not.toContain(t);
    for (const t of FILE_PAYLOAD_TYPES) expect(CORE_ONLY_PAYLOAD_TYPES).not.toContain(t);
  });

  it('matches the record kinds, receipt types and fee types of 05 §2.1 and §3.1', () => {
    expect(RECORD_KINDS).toEqual({
      MESSAGE: 1,
      FILE: 2,
      OFFER: 3,
      ACCEPT: 4,
      DELIVERY: 5,
      NOTE: 6,
    });
    expect(RECEIPT_TYPES).toEqual({ DELIVERED: 1, OPENED: 2, ACCEPTED: 3, REJECTED: 4 });
    // Solidity enum FeeType { NOTARIZE, REGISTER, ANCHOR, DEAL, DISCLOSE }: ordinal values.
    expect(FEE_TYPES).toEqual({ NOTARIZE: 0, REGISTER: 1, ANCHOR: 2, DEAL: 3, DISCLOSE: 4 });
  });

  it('matches the MCP status values (06 §1 rule 3) and approval statuses (06 §2.5)', () => {
    expect(MCP_STATUSES).toEqual([
      'ok',
      'submitted',
      'pending_approval',
      'needs_setup',
      'needs_credits',
      'not_found',
      'rejected',
      'error',
    ]);
    expect(APPROVAL_STATUSES).toEqual(['pending', 'approved', 'denied', 'expired']);
  });

  it('has the 15 frozen tool names (06 §2.0, D-53, D-55) and the seven that can need approval', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(15);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(15);
    expect(MCP_TOOL_NAMES).toContain('agentlink_propose_terms');
    expect(MCP_TOOL_NAMES).toContain('agentlink_respond_to_terms');
    for (const name of MCP_TOOL_NAMES) expect(name).toMatch(/^agentlink_[a-z_]+$/);
    expect([...APPROVAL_TOOL_NAMES].sort()).toEqual(
      [
        'agentlink_accept_invite',
        'agentlink_send',
        'agentlink_propose_terms',
        'agentlink_respond_to_terms',
        'agentlink_notarize',
        'agentlink_acknowledge',
        'agentlink_export_proof_pack',
      ].sort(),
    );
    for (const name of APPROVAL_TOOL_NAMES) expect(MCP_TOOL_NAMES).toContain(name);
  });

  it('has the owner-action ops, decisions and revoke reasons of 04 §2.5.1', () => {
    expect([...OWNER_ACTION_OPS].sort()).toEqual(
      [
        'agent.revoke',
        'approval.cancel',
        'approval.decide',
        'approval.decideBatch',
        'contact.check',
        'policy.set',
      ].sort(),
    );
    expect(APPROVAL_DECISIONS).toEqual(['approve', 'deny']);
    expect(REVOKE_REASONS).toEqual(['compromised', 'retired', 'other']);
    expect(APPROVAL_ID_PREFIX).toBe('apr_');
    expect(APPROVAL_SUMMARY_MAX_CHARS).toBe(200);
  });

  it('has the batch approval bounds of 04 §2.5.2 (D-68; 20 and 600 s are proposed)', () => {
    expect(APPROVAL_BATCH_MIN_ITEMS).toBe(2);
    expect(APPROVAL_BATCH_MAX_ITEMS).toBe(20);
    expect(APPROVAL_BATCH_LOCAL_MAX_LIFETIME_SECONDS).toBe(600);
  });

  it('has the size limits of 04 §3.5 and 06 §3 (KB = 1024 bytes)', () => {
    expect(MAX_ENVELOPE_BYTES).toBe(24 * 1024);
    // ALF1 header: magic 4 + version 1 + chunkSize 4 + noncePrefix 8 (04 §4); one GCM tag per chunk.
    expect(ALF1_HEADER_BYTES).toBe(17);
    expect(AEAD_TAG_BYTES).toBe(16);
    // 04 §3.1.1: inline field ≤ 16 384 base64url characters = 12 288 bytes of ALF1 ciphertext, so
    // the largest inline plaintext is 12 288 − 17 − 16 = 12 255 bytes.
    expect(MAX_INLINE_CIPHERTEXT_BYTES).toBe(12 * 1024);
    expect(MAX_INLINE_FILE_BYTES).toBe(12 * 1024 - 17 - 16);
    expect(MIN_RECIPIENTS).toBe(2);
    expect(MAX_RECIPIENTS).toBe(5);
    expect(INVITE_DEFAULT_EXPIRY_DAYS).toBe(7);
    expect(FILE_LINK_MAX_EXPIRY_DAYS).toBe(7);
  });

  it('has the byte lengths of 04 §3.1, §3.3, §2.5.1, §3.6 and §3.6.1', () => {
    expect(BYTE_LENGTHS).toEqual({
      id: 16,
      thread: 16,
      kid: 16,
      nonce: 16,
      inviteId: 16,
      approvalId: 16,
      key: 32,
      secret: 32,
      hmac: 32,
      safetyCode: 32,
      sha256: 32,
      hpkeEnc: 32,
      wrappedCek: 48,
      iv: 12,
      tag: 16,
      keyCommitment: 32,
      bip340Sig: 64,
      eip712Sig: 65,
    });
  });

  it('bounds relay lists carried with a card to 2–16 (04 §3.4; G-24, D-65)', () => {
    expect(MIN_RELAYS).toBe(2);
    expect(MAX_RELAYS).toBe(16);
  });

  it('pins the G-7 times: skew, lifetimes, approval TTL, nonce retention, budget window', () => {
    // 04 §2.5.1 "Lifetimes, skew and nonces"; 04 §3.4.1 approval TTL; 04 §3.4.2 scope expiry;
    // 06 §3 "Daily budget window".
    expect(CLOCK_SKEW_SECONDS).toBe(300);
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS).toEqual({
      'approval.decide': 86_400,
      'approval.decideBatch': 86_400,
      'approval.cancel': 604_800,
      'policy.set': 86_400,
      'contact.check': 86_400,
      'agent.revoke': null,
    });
    expect(LATER_OP_DEFAULT_LIFETIME_SECONDS).toBe(600);
    expect(MAX_OWNER_ACTION_LIFETIME_SECONDS).toBe(604_800);
    expect(APPROVAL_TTL_SECONDS).toBe(86_400);
    expect(NONCE_RETENTION_SECONDS).toBe(30 * 86_400);
    expect(BUDGET_WINDOW_SECONDS).toBe(86_400);
    expect(COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS).toBe(7 * 86_400);
  });

  it('keeps the G-7 relations the spec states', () => {
    const lifetimes = (
      Object.values(OWNER_ACTION_MAX_LIFETIME_SECONDS) as (number | null)[]
    ).filter((l): l is number => l !== null);
    // Every op that expires is covered by OWNER_ACTION_OPS or named in 04 §2.5.1; agent.revoke never expires.
    for (const op of OWNER_ACTION_OPS) expect(op in OWNER_ACTION_MAX_LIFETIME_SECONDS).toBe(true);
    // ...and, since contact.check has its schema (M1-2f), every listed lifetime belongs to an op.
    expect(Object.keys(OWNER_ACTION_MAX_LIFETIME_SECONDS).sort()).toEqual(
      [...OWNER_ACTION_OPS].sort(),
    );
    // No op may exceed 7 days; nonces outlive the longest lifetime plus skew.
    for (const l of [...lifetimes, LATER_OP_DEFAULT_LIFETIME_SECONDS]) {
      expect(l).toBeLessThanOrEqual(MAX_OWNER_ACTION_LIFETIME_SECONDS);
    }
    expect(NONCE_RETENTION_SECONDS).toBeGreaterThan(
      MAX_OWNER_ACTION_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS,
    );
    // An approval.decide is useless after its request expires (L = the TTL).
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.decide']).toBe(APPROVAL_TTL_SECONDS);
    // A batch never outlives any of its requests (04 §2.5.2 "Expiry"): the same bound.
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.decideBatch']).toBe(APPROVAL_TTL_SECONDS);
    // approval.cancel must reach an offline agent before the scope it cancels expires.
    expect(OWNER_ACTION_MAX_LIFETIME_SECONDS['approval.cancel']).toBe(
      COMMITMENT_SCOPE_MAX_LIFETIME_SECONDS,
    );
    expect(Object.isFrozen(OWNER_ACTION_MAX_LIFETIME_SECONDS)).toBe(true);
  });

  it('references the policy defaults and their protocol caps (06 §3; values land in M1-2b)', () => {
    expect(POLICY_DEFAULTS_SPEC).toBe('docs/foundation/06-mcp-server.md §3');
    expect(POLICY_PROTOCOL_LIMITS).toEqual({
      'envelopes.maxEnvelopeKB': 24,
      'files.defaultExpiryDays': 7,
    });
    expect(POLICY_PROTOCOL_LIMITS['envelopes.maxEnvelopeKB'] * 1024).toBe(MAX_ENVELOPE_BYTES);
  });

  it('describes the AgentCard EIP-712 struct of 04 §2.4 field for field', () => {
    expect(AGENT_CARD_EIP712_DOMAIN).toEqual({ name: 'OCC AgentCard', version: '1' });
    expect(AGENT_CARD_EIP712_TYPES).toEqual({
      AgentCard: [
        { name: 'version', type: 'uint8' },
        { name: 'agentEvm', type: 'address' },
        { name: 'agentNostr', type: 'bytes32' },
        { name: 'agentEnc', type: 'bytes32' },
        { name: 'ownerEvm', type: 'address' },
        { name: 'ownerNostr', type: 'bytes32' },
        { name: 'ownerEnc', type: 'bytes32' },
        { name: 'nameHash', type: 'bytes32' },
        { name: 'relaysHash', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'keyEpoch', type: 'uint32' },
      ],
    });
    // The JSON card has exactly the struct's fields.
    expect(Object.keys(agentCard())).toEqual(
      AGENT_CARD_EIP712_TYPES.AgentCard.map((field) => field.name),
    );
  });

  it('freezes constant arrays and maps so callers cannot widen them at run time', () => {
    const values = [
      PAYLOAD_TYPES,
      RECORD_KINDS,
      BYTE_LENGTHS,
      MCP_TOOL_NAMES,
      APPROVAL_TOOL_NAMES,
      AGENT_CARD_EIP712_TYPES,
      AGENT_CARD_EIP712_TYPES.AgentCard,
      ...AGENT_CARD_EIP712_TYPES.AgentCard,
    ];
    for (const value of values) {
      // isFrozen(undefined) is true, so first prove the export exists and is an object.
      expect(typeof value).toBe('object');
      expect(value).not.toBeNull();
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});
