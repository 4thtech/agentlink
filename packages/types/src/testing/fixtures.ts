// Test fixtures for @agentlink/types. Not part of the build (tsconfig.json excludes src/testing).
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

export const CARD_SIG = hex0x(65, '3c');
export const RELAYS = ['wss://relay.example.org', 'wss://nos.example.net:7447/sub/path'];

export const invite = () => ({
  v: 1,
  inviteId: ID16,
  secret: KEY32,
  card: agentCard(),
  cardSig: CARD_SIG,
  name: "Tali's Claude",
  relays: [...RELAYS],
  expiresAt: 1760600000,
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
  params: { version: 2, policy: { contacts: { acceptInvites: 'approval' } } },
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
  offer: payloadOf('offer', { terms: { termsId: ID16, version: 1 }, termsHash: SHA, note: null }),
  accept: payloadOf('accept', { terms: { termsId: ID16, version: 1 }, termsHash: SHA, note: 'ok' }),
  reject: payloadOf('reject', { terms: { termsId: ID16 }, termsHash: SHA, note: 'too expensive' }),
  delivery: payloadOf('delivery', { milestone: 'd1', items: [1, 2, 3] }, [fileEntryUrl()]),
  note: payloadOf('note', 'a note to myself'),
  file: payloadOf('file', 'here is the file', [fileEntryUrl()]),
  ack: payloadOf('ack', { envelopeId: ID16 }),
  handshake: payloadOf('handshake', {
    inviteId: ID16,
    card: agentCard(),
    cardSig: CARD_SIG,
    name: 'Denis',
    relays: [...RELAYS],
    proof: KEY32,
  }),
  'handshake-ack': payloadOf('handshake-ack', { inviteId: ID16, handshakeId: ID16_B }),
  proof: payloadOf('proof', {
    envelopeId: ID16,
    chainId: 8453,
    recordId: KEY32,
    salt: b64u(32, 'D'),
  }),
  approval: payloadOf('approval', { signed: signed(approvalDecideAction()) }),
  'approval-request': payloadOf('approval-request', {
    approvalId: APPROVAL_ID,
    agent: AGENT_EVM,
    action: {
      tool: 'agentlink_send',
      args: { to: 'contact_1', type: 'accept', body: { termsHash: SHA } },
      context: { contactEvm: OWNER_EVM },
    },
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
  aead: { alg: 'A256GCM', iv: b64u(12), ct: b64u(300) },
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
