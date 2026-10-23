// Test fixtures for @4thtech-io/types. Not part of the build (tsconfig.json excludes src/testing).
//
// Every value here is a structurally valid example built by hand from the spec text (04 §2.4, §2.5.1,
// §3.1, §3.4, §3.4.1, §3.6). Nothing is a real key, signature or secret: the "keys" and "signatures"
// are fixed filler bytes that only have the right shape.

/** Canonical base64url (no padding) of `n` bytes, built without decoding: filler chars, zero tail bits. */
export function b64u(n: number, fill = 'B'): string {
  const rem = n % 3;
  const len = Math.floor(n / 3) * 4 + (rem === 0 ? 0 : rem + 1);
  if (rem === 0) return fill.repeat(len);
  // 'A' encodes 0, so the unused low bits of the last character are zero (canonical).
  return fill.repeat(len - 1) + 'A';
}

/** Lowercase hex of `n` bytes, no prefix. */
export const hex = (n: number, pair = 'ab'): string => pair.repeat(n);
/** `0x` + lowercase hex of `n` bytes. */
export const hex0x = (n: number, pair = 'ab'): string => `0x${hex(n, pair)}`;

export const ID16 = b64u(16); // 22 chars
export const ID16_B = b64u(16, 'C');
export const KEY32 = b64u(32); // 43 chars
export const AGENT_EVM = '0x' + '1a'.repeat(20);
export const OWNER_EVM = '0x' + '2b'.repeat(20);
export const OWNER_NOSTR = hex(32, 'c3');
export const AGENT_NOSTR = hex(32, 'd4');
export const SHA = hex(32, 'e5');
/** An on-chain 32-byte value (recordId, salt): 0x + lowercase hex (04 §2.4.1). */
export const B32 = `0x${hex(32, '7a')}`;
export const BIP340_SIG = hex(64, 'f6');
export const APPROVAL_ID = `apr_${ID16}`;

export const agentCard = () => ({
  version: 1,
  agentEvm: AGENT_EVM,
  agentNostr: `0x${AGENT_NOSTR}`,
  agentEnc: hex0x(32, '0e'),
  ownerEvm: OWNER_EVM,
  ownerNostr: `0x${OWNER_NOSTR}`,
  ownerEnc: hex0x(32, '0f'),
  nameHash: hex0x(32, '11'),
  relaysHash: hex0x(32, '22'),
  issuedAt: 1760000000,
  expiresAt: 0,
  keyEpoch: 0,
});

/** A canonical-form ECDSA signature: r = s = 0x3c…3c (in range, low s), v = 27 (0x1b). */
export const CARD_SIG = `0x${hex(64, '3c')}1b`;
/** The agent's EIP-712 signature over the card (04 §2.9), canonical form: r = s = 0x4d…4d, v = 28. */
export const CARD_AGENT_SIG = `0x${hex(64, '4d')}1c`;
export const RELAYS = ['wss://relay.example.org', 'wss://nos.example.net:7447/sub/path'];
/** Safety-code commitment, nonces and hashes (04 §3.6, §3.6.1): filler bytes of the right shape. */
export const CODE_COMMIT = b64u(32, 'D');
export const CODE_NONCE = b64u(32, 'E');
export const CODE_REVEAL = b64u(32, 'G');
/** `inviterCardHash`: sha256(JCS(card)) as bare 64 lowercase hex (04 §3.6). */
export const INVITER_CARD_HASH = hex(32, '9f');
/** `handshakeHash`: an `envelopeHash`, so `0x` + 64 lowercase hex (04 §2.4.1, §3.4.1). */
export const HANDSHAKE_HASH = hex0x(32, '8e');

export const invite = () => ({
  v: 1,
  inviteId: ID16,
  secret: KEY32,
  card: agentCard(),
  cardSig: CARD_SIG,
  cardAgentSig: CARD_AGENT_SIG,
  codeCommit: CODE_COMMIT,
  name: "Tali's Claude",
  relays: [...RELAYS],
  expiresAt: 1760600000,
});

// --- USD amounts (04 §2.4.1) ---------------------------------------------------------------------

/** The strings the M1-2b card names, plus the other non-canonical USD forms of 04 §2.4.1. */
export const BAD_USD_STRINGS = [
  '01',
  '1.',
  '1.0',
  '0.10',
  '1e3',
  '-1',
  '1.0000001',
  '1000000000',
  '',
  '.5',
  '+1',
  '00',
  '0.0',
  '5.00',
  ' 1',
  '1 ',
  '1,5',
  '0x1',
  'Infinity',
  'NaN',
  '１',
  '1\n',
  '0.000000',
];

// --- policy (06 §3, G-32) ------------------------------------------------------------------------

/** Two contacts' agent IDs, in strictly ascending byte order (06 §3 "Agent IDs"). */
export const CONTACT_A = '0x' + '3d'.repeat(20);
export const CONTACT_B = '0x' + '4e'.repeat(20);

/**
 * The 06 §3 defaults in the policy JSON form, transcribed by hand from the YAML listing of
 * docs/foundation/06-mcp-server.md §3 and its "The defaults" bullet: `contacts.allowed: "paired"`,
 * empty arrays, the USD values "5", "1" and "0", `autoAcceptMinUSD: null`, `contactRules: []`.
 */
export const policyDefaultsFromSpec = () => ({
  contacts: {
    acceptInvites: 'approval',
    unknownSenders: 'queue',
    allowed: 'paired',
    rateLimitPerContactPerHour: 120,
  },
  files: {
    allowedFolders: [],
    inboxFolder: '~/AgentLink/Inbox',
    maxSendSizeMB: 100,
    maxReceiveSizeMB: 200,
    storage: 'auto',
    defaultExpiryDays: 7,
    deleteAfter: 'expiry',
    ownerArchive: false,
  },
  envelopes: {
    maxEnvelopeKB: 24,
  },
  proofs: {
    notarize: 'allow',
    dailyBudgetUSD: '5',
    perActionMaxUSD: '1',
    allowKeyDisclosure: 'approval',
    exportFolder: '~/AgentLink/Proofs',
    defaultChain: 'base',
  },
  receipts: {
    autoDelivered: false,
    autoOpened: false,
  },
  commitments: {
    accept: 'approval',
    autoAcceptContacts: [],
    autoAcceptMaxUSD: '0',
    autoAcceptDirection: 'buy',
    autoAcceptMinUSD: null,
  },
  contactRules: [],
});

/** A non-default policy: explicit contact lists, folders, sell limits and two contact rules. */
export const policyWithRules = () => {
  const d = policyDefaultsFromSpec();
  return {
    ...d,
    contacts: { ...d.contacts, allowed: [CONTACT_A, CONTACT_B] },
    files: { ...d.files, allowedFolders: ['~/Documents/Contracts', '/srv/agentlink/out'] },
    proofs: {
      ...d.proofs,
      notarize: 'approval',
      allowKeyDisclosure: 'deny',
      defaultChain: 'base-sepolia',
    },
    commitments: {
      ...d.commitments,
      autoAcceptContacts: [CONTACT_A],
      autoAcceptMaxUSD: '250.5',
      autoAcceptDirection: 'sell',
      autoAcceptMinUSD: '1000',
    },
    contactRules: [
      { contact: CONTACT_A, proofs: { notarize: 'allow', perActionMaxUSD: '2.5' } },
      { contact: CONTACT_B, proofs: { perActionMaxUSD: '0.01' } },
    ],
  };
};

// --- approvals (04 §3.4.1, §3.4.2) ---------------------------------------------------------------

/** A fee token address (Record `feeToken`) and a fee of 0.1 USD in 6-decimal base units. */
export const FEE_TOKEN = '0x' + '55'.repeat(20);
export const fee = () => ({ token: FEE_TOKEN, amount: '100000', usd: '0.1' });
export const counterparty = () => ({ agentId: CONTACT_A, ownerKey: hex(32, 'c4') });
/** An envelopeHash (EVM-native, 0x, 04 §2.4.1). */
export const ENVELOPE_HASH = hex0x(32, 'e1');

/** CommitmentScope v1 (04 §3.4.2) for an `accept` with notarize. */
export const commitmentScope = () => ({
  v: 1,
  kind: 'agentlink/commitment',
  agentId: AGENT_EVM,
  decision: 'accept',
  counterparty: counterparty(),
  thread: ID16_B,
  termsId: b64u(16, 'T'),
  version: 3,
  termsHash: SHA,
  answers: { envelopeId: ID16, envelopeHash: ENVELOPE_HASH },
  notarize: true,
  maxFeeUsd: '0.1',
  createdAt: 1760000000,
  expiresAt: 1760600000,
});

/** A firm offer scope: no `answers`, always notarized (04 §3.4.2). */
export const firmOfferScope = () => ({
  ...commitmentScope(),
  decision: 'offer',
  answers: null,
});

/**
 * Canonical terms (04 §3.4, M1-21): this agent (AGENT_EVM) pays, the contact (CONTACT_A) delivers.
 * Version 3 of negotiation `b64u(16, 'T')`, matching `commitmentScope()`.
 */
export const terms = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  termsId: b64u(16, 'T'),
  version: 3,
  parties: [AGENT_EVM, CONTACT_A],
  subject: 'Spec v2 – milestone 3',
  deliverables: [
    {
      id: 'd1',
      description: 'Revised spec, chapters 1–4 (日本語 ✓)',
      by: CONTACT_A,
      plaintextSha256: null,
    },
  ],
  price: { amount: '1500.00', currency: 'EUR', payer: AGENT_EVM },
  deadlines: [{ ref: 'd1', due: '2026-11-30T17:00:00Z' }],
  validUntil: 1760600000,
  previousTermsHash: hex(32, '5c'),
  ...over,
});

/** The first version of a negotiation: no previous hash. */
export const firstTerms = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  terms({ version: 1, previousTermsHash: null, ...over });

/** A `TermsInput` (06 §2.2a, D-55): only the fields an agent may supply. */
export const termsInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject: 'Spec v2 – milestone 3',
  deliverables: [{ description: 'Revised spec, chapters 1–4 (日本語 ✓)', by: 'them' }],
  price: { amount: '1500.00', currency: 'EUR', payer: 'me' },
  deadlines: [{ ref: 'd1', due: '2026-11-30T17:00:00Z' }],
  validUntil: '2025-10-16T07:33:20Z',
  ...over,
});

/** Stored canonical terms in `context.terms`: the terms the scope is bound to. */
const storedTerms = () => terms();

/** One valid `approval-request.action` per approval tool (06 §2.0 "Approval" column). */
export const approvalActions = () => ({
  agentlink_accept_invite: {
    tool: 'agentlink_accept_invite',
    args: { inviteUrl: 'https://agentlink.example/i#abc' },
    context: {
      triggers: ['contacts.acceptInvites'],
      inviteId: ID16,
      counterparty: counterparty(),
    },
  },
  agentlink_send: {
    tool: 'agentlink_send',
    args: {
      to: CONTACT_A,
      text: 'Signed contract attached',
      type: 'text',
      path: '/Users/tali/Documents/Contracts/contract-signed.pdf',
      notarize: true,
      expiresInDays: 7,
    },
    context: {
      triggers: ['proofs.notarize'],
      counterparty: counterparty(),
      file: { plaintextSha256: SHA, size: 1000 },
      fee: fee(),
    },
  },
  agentlink_propose_terms: {
    tool: 'agentlink_propose_terms',
    args: { to: CONTACT_A, terms: termsInput(), notarize: true },
    context: {
      triggers: ['commitments.accept', 'proofs.perActionMaxUSD'],
      scope: firmOfferScope(),
      terms: storedTerms(),
      fee: fee(),
    },
  },
  agentlink_respond_to_terms: {
    tool: 'agentlink_respond_to_terms',
    args: { envelopeId: ID16, decision: 'accept', notarize: true },
    context: {
      triggers: ['commitments.accept'],
      scope: commitmentScope(),
      terms: storedTerms(),
      fee: fee(),
    },
  },
  agentlink_notarize: {
    tool: 'agentlink_notarize',
    args: { envelopeId: ID16 },
    context: {
      triggers: ['proofs.dailyBudgetUSD', 'proofs.perActionMaxUSD'],
      counterparty: counterparty(),
      envelopeHash: ENVELOPE_HASH,
      fee: fee(),
    },
  },
  agentlink_acknowledge: {
    tool: 'agentlink_acknowledge',
    args: { envelopeId: ID16, type: 'accepted' },
    context: {
      triggers: ['commitments.accept'],
      counterparty: counterparty(),
      recordId: B32,
      receipt: 'ACCEPTED',
    },
  },
  agentlink_export_proof_pack: {
    tool: 'agentlink_export_proof_pack',
    args: { envelopeId: ID16, includeContentKey: true },
    context: {
      triggers: ['proofs.allowKeyDisclosure'],
      recordId: B32,
      envelopeHash: ENVELOPE_HASH,
    },
  },
});

/** An approval-request body for an action (04 §3.4.1), with the G-7 TTL applied by default. */
export const approvalRequestFor = (action: unknown, expiresAt = 1760086400) => ({
  approvalId: APPROVAL_ID,
  agent: AGENT_EVM,
  action,
  actionDigest: SHA,
  summary: 'Accept version 3 from “Marko Novak” (self-declared)',
  requestedAt: 1760000000,
  expiresAt,
});

// --- proofs (07 §8, 06 §2.4) ---------------------------------------------------------------------

/** The Record struct in its JSON form (05 §3.1, 04 §2.4.1). Kind 4 = ACCEPT. */
export const record = () => ({
  signer: AGENT_EVM,
  envelopeHash: ENVELOPE_HASH,
  recipientCommitment: hex0x(32, 'c1'),
  parentRecordId: hex0x(32, '00'),
  appId: hex0x(32, '00'),
  kind: 4,
  feeToken: FEE_TOKEN,
  maxFee: '100000',
  nonce: '123456789012345678901234567890',
  deadline: 1760003600,
});

/** The Receipt struct in its JSON form (05 §3.1). Type 3 = ACCEPTED. */
export const receiptStruct = () => ({
  signer: CONTACT_A,
  recordId: B32,
  receiptType: 3,
  salt: hex0x(32, '5b'),
  deadline: 1760003600,
});

/**
 * The 07 §8 example proof pack with every placeholder filled and every optional part present: a
 * proof of agreement whose exporter includes its owner's approval of the commitment (04 §3.4).
 */
export const proofPack = () => ({
  type: 'agentlink.proof',
  version: 1,
  chainId: 8453,
  notary: hex0x(20, '9a'),
  recordId: B32,
  record: record(),
  signature: CARD_SIG,
  signer: { evm: AGENT_EVM, agentCard: agentCard(), cardSig: CARD_SIG },
  envelopeHash: ENVELOPE_HASH,
  envelope: envelope(),
  recipient: { evm: CONTACT_A, salt: hex0x(32, '5b') },
  receipts: [
    { type: 'DELIVERED', signer: CONTACT_A, txHash: hex0x(32, '7e'), at: '2026-10-14T12:00:00Z' },
    { type: 'ACCEPTED', signer: CONTACT_A, txHash: hex0x(32, '7f'), at: '2026-10-14T12:05:00Z' },
  ],
  disclosure: { contentKey: KEY32 },
  ownerApproval: {
    signed: signed(approvalDecideAction()),
    action: approvalActions().agentlink_respond_to_terms,
  },
  exportedAt: '2026-10-14T12:30:00Z',
});

/** The smallest valid pack: no optional parts, nothing disclosed, no approval, no receipts. */
export const minimalProofPack = () => ({
  type: 'agentlink.proof',
  version: 1,
  chainId: 8453,
  notary: hex0x(20, '9a'),
  recordId: B32,
  record: record(),
  signature: CARD_SIG,
  signer: { evm: AGENT_EVM },
  envelopeHash: ENVELOPE_HASH,
  receipts: [],
  disclosure: null,
  ownerApproval: null,
  exportedAt: '2026-10-14T12:30:00Z',
});

/** ProofStatus (06 §2.4) for a confirmed record. */
export const proofStatus = () => ({
  status: 'ok',
  advanced: { chain: 'base' },
  recordId: B32,
  txHash: hex0x(32, '7e'),
  fee: { token: FEE_TOKEN, amount: '100000', usd: '0.1', protocolUsd: '0.1', integratorUsd: '0' },
  receipts: [{ type: 'DELIVERED', at: '2026-10-14T12:00:00Z' }],
  explorerUrl: `https://basescan.org/tx/${hex0x(32, '7e')}`,
  verifyUrl: `https://verify.agentlink.example/r/${B32}`,
});

/** The 06 §2.5 `pending_approval` example with its placeholders filled. */
export const pendingApprovalResult = () => ({
  status: 'pending_approval',
  approvalId: APPROVAL_ID,
  summary: "Notarize 'contract-signed.pdf' to Marko's agent for $0.10",
  url: `http://127.0.0.1:47321/approve/${APPROVAL_ID}`,
  nextStep:
    'Tell the user approval is needed and share the link. After approval, call the same tool again with approvalId.',
});

export const approvalDecideAction = () => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'approval.decide',
  params: { approvalId: APPROVAL_ID, actionDigest: SHA, decision: 'approve' },
  nonce: ID16,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

export const policySetAction = () => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'policy.set',
  params: { version: 2, policy: policyDefaultsFromSpec() },
  nonce: ID16_B,
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

export const agentRevokeAction = () => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'agent.revoke',
  params: { reason: 'compromised' },
  nonce: ID16,
  issuedAt: 1760000000,
  expiresAt: 0,
});

export const approvalCancelAction = () => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'approval.cancel',
  params: { approvalId: APPROVAL_ID },
  nonce: b64u(16, 'Z'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

/**
 * Base64url characters in ascending byte (ASCII) order: `-` < digits < upper case < `_` < lower case.
 * This is not base64url value order (`-` is 62, `A` is 0), so fixtures built from it check byte order.
 */
export const B64U_ASCII_ORDER = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/** A canonical `approvalId` whose random part is filled with `fill` (one base64url character). */
export const approvalIdOf = (fill: string) => `apr_${b64u(16, fill)}`;

/** `approval.decide` params for item `i` of a batch: ids in byte order, mixed decisions. */
export const batchItem = (i: number) => ({
  approvalId: approvalIdOf(B64U_ASCII_ORDER.charAt(i)),
  actionDigest: hex(32, (i + 16).toString(16)),
  decision: i % 3 === 1 ? 'deny' : 'approve',
});

/** `approval.decideBatch` (04 §2.5.2, D-68) with `n` items in strictly ascending `approvalId` order. */
export const approvalDecideBatchAction = (n = 2) => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'approval.decideBatch',
  params: { items: Array.from({ length: n }, (_, i) => batchItem(i)) },
  nonce: b64u(16, 'Y'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

/** A `pairingDigest` (04 §3.6.1): the safety-code transcript digest, 64 lowercase hex. */
export const PAIRING_DIGEST = hex(32, '6b');

/** `contact.check` (04 §2.5.1, §3.6.1; G-28): the owner compared the safety code with `contact`. */
export const contactCheckAction = () => ({
  v: 1,
  agent: AGENT_EVM,
  owner: OWNER_NOSTR,
  op: 'contact.check',
  params: { contact: CONTACT_A, pairingDigest: PAIRING_DIGEST },
  nonce: b64u(16, 'X'),
  issuedAt: 1760000000,
  expiresAt: 1760000600,
});

export const signed = <T>(body: T) => ({ body, sig: BIP340_SIG });

export const fileEntryInline = () => ({
  name: 'contract-signed.pdf',
  size: 1000,
  mime: 'application/pdf',
  plaintextSha256: SHA,
  ciphertextSha256: hex(32, '99'),
  inline: b64u(1033),
  url: null,
  fileKey: KEY32,
  expiresAt: 1760600000,
});

export const fileEntryUrl = () => ({
  name: 'big.tar',
  size: 50_000_000,
  mime: 'application/x-tar',
  plaintextSha256: SHA,
  ciphertextSha256: hex(32, '98'),
  inline: null,
  url: 'https://drop.agentlink.4thtech.io/v1/o/abc?sig=xyz',
  fileKey: KEY32,
  expiresAt: 1760600000,
});

const payloadOf = (type: string, body: unknown, files: unknown[] = []) => ({
  type,
  body,
  replyTo: null,
  files,
});

/** One valid payload per type, in PAYLOAD_TYPES order (04 §3.4). */
export const payloads = (): Record<string, Record<string, unknown>> => ({
  text: payloadOf('text', 'Hello from Tali’s agent ✓ — 你好', [fileEntryInline()]),
  request: payloadOf('request', { kind: 'refresh-link', envelopeId: ID16, ciphertextSha256: SHA }),
  offer: payloadOf('offer', { terms: firstTerms(), termsHash: SHA, note: null }),
  accept: payloadOf('accept', { terms: firstTerms(), termsHash: SHA, note: null }),
  reject: payloadOf('reject', { terms: firstTerms(), termsHash: SHA, note: 'too expensive' }),
  delivery: payloadOf('delivery', { milestone: 'd1', items: [1, 2, 3] }, [fileEntryUrl()]),
  note: payloadOf('note', 'a note to myself'),
  file: payloadOf('file', 'here is the file', [fileEntryUrl()]),
  ack: payloadOf('ack', { envelopeId: ID16 }),
  handshake: payloadOf('handshake', {
    inviteId: ID16,
    card: agentCard(),
    cardSig: CARD_SIG,
    cardAgentSig: CARD_AGENT_SIG,
    name: 'Denis',
    relays: [...RELAYS],
    proof: KEY32,
    codeNonce: CODE_NONCE,
    codeCommit: CODE_COMMIT,
    inviterCardHash: INVITER_CARD_HASH,
  }),
  'handshake-ack': payloadOf('handshake-ack', {
    inviteId: ID16,
    handshakeId: ID16_B,
    handshakeHash: HANDSHAKE_HASH,
    codeReveal: CODE_REVEAL,
    card: agentCard(),
    cardSig: CARD_SIG,
    relays: [...RELAYS],
  }),
  proof: payloadOf('proof', {
    envelopeId: ID16,
    chainId: 8453,
    recordId: B32,
    salt: hex0x(32, '5b'),
  }),
  approval: payloadOf('approval', { signed: signed(approvalDecideAction()) }),
  'approval-request': payloadOf('approval-request', {
    approvalId: APPROVAL_ID,
    agent: AGENT_EVM,
    action: approvalActions().agentlink_send,
    actionDigest: SHA,
    summary: 'Send an accept to “Marko Novak” (self-declared)',
    requestedAt: 1760000000,
    expiresAt: 1760086400,
  }),
  policy: payloadOf('policy', { signed: signed(policySetAction()) }),
  'card-update': payloadOf('card-update', {
    card: { ...agentCard(), keyEpoch: 1 },
    cardSig: CARD_SIG,
    name: 'Denis',
    relays: [...RELAYS],
  }),
  revoke: payloadOf('revoke', { signed: signed(agentRevokeAction()) }),
});

/** The body of the fixture payload of `type`. */
export function bodyOf(type: string): unknown {
  const payload = payloads()[type];
  if (payload === undefined) throw new Error(`no fixture for ${type}`);
  return payload.body;
}

export const envelope = () => ({
  v: 1,
  id: ID16,
  thread: ID16_B,
  from: AGENT_NOSTR,
  createdAt: 1760000000,
  recipients: [
    { kid: ID16, enc: KEY32, wk: b64u(48) },
    { kid: ID16_B, enc: b64u(32, 'E'), wk: b64u(48, 'F') },
    { kid: b64u(16, 'G'), enc: b64u(32, 'H'), wk: b64u(48, 'I') },
    { kid: b64u(16, 'J'), enc: b64u(32, 'K'), wk: b64u(48, 'L') },
  ],
  aead: { alg: 'A256GCM-KC', iv: b64u(12), kc: b64u(32, 'M'), ct: b64u(300) },
  sig: BIP340_SIG,
});

// --- helpers --------------------------------------------------------------------------------------

/** Deep clone of a JSON value. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Path = readonly (string | number)[];

/** Returns a deep clone of `obj` with the value at `path` replaced (or deleted when `value` is DELETE). */
export const DELETE = Symbol('delete');
export function edit<T>(obj: T, path: Path, value: unknown): T {
  const copy = clone(obj) as unknown as Record<string | number, unknown>;
  let cur: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === DELETE) delete cur[last];
  else cur[last] = value;
  return copy as unknown as T;
}
