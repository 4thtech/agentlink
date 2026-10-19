// Per-path decoders of 04 §2.4.1 (M1-2a, `encodings` suite). The decoder is chosen by schema path,
// never by field name; a value decodes only in its path's one canonical form, and comparisons decode
// both sides to bytes. The cross-runtime cases are the M1-1h vectors (test-vectors/encodings).
import { describe, expect, it } from 'vitest';
import {
  ENCODING_PATHS,
  bytesToHex,
  decodeAtPath,
  equalAtPaths,
  isEncodingPath,
  type EncodingPath,
} from './index.js';

// Every binary schema path of the 04 §2.4.1 table (the `encodings` vector paths, plus the table's
// policy contacts, fee tokens and amounts, `aead.kc` and the pack's `signer.cardSig`), its tool-result
// row and `approvalId`.
const SPEC_PATHS = {
  address: [
    'OwnerAction.agent',
    'contact.check.params.contact',
    'tool.contact.id',
    'tool.agent.id',
    'approval-request.agent',
    'terms.parties[]',
    'terms.deliverables[].by',
    'terms.price.payer',
    'CommitmentScope.agentId',
    'CommitmentScope.counterparty.agentId',
    'AgentCard.agentEvm',
    'AgentCard.ownerEvm',
    'ProofPack.notary',
    'ProofPack.signer.evm',
    'ProofPack.recipient.evm',
    'ProofPack.receipts[].signer',
    'Record.signer',
    'Receipt.signer',
    'Record.feeToken',
    'EIP3009.auth.from',
    'EIP3009.auth.to',
    'ProofStatus.signer',
    'ProofStatus.fee.token',
    'approval-request.action.context.fee.token',
    'policy.contacts.allowed[]',
    'policy.commitments.autoAcceptContacts[]',
    'policy.contactRules[].contact',
  ],
  bytes32: [
    'proof.recordId',
    'ProofPack.recordId',
    'handshake-ack.handshakeHash',
    'proof.salt',
    'ProofPack.recipient.salt',
    'CommitmentScope.answers.envelopeHash',
    'ProofPack.envelopeHash',
    'Record.envelopeHash',
    'Record.recipientCommitment',
    'Record.parentRecordId',
    'Record.appId',
    'Receipt.recordId',
    'Receipt.salt',
    'recordStructHash',
    'txHash',
    'AgentCard.agentNostr',
    'AgentCard.agentEnc',
    'AgentCard.ownerNostr',
    'AgentCard.ownerEnc',
    'AgentCard.nameHash',
    'AgentCard.relaysHash',
    'DomainClaim.ownerNostr',
    'EIP3009.auth.nonce',
    'EIP3009.auth.r',
    'EIP3009.auth.s',
    'ProofStatus.recordId',
    'ProofStatus.txHash',
    'verify_proof_pack.recordId',
    'verify_proof_pack.envelopeHash',
  ],
  ecdsa: [
    'invite.cardSig',
    'handshake.cardSig',
    'handshake-ack.cardSig',
    'card-update.cardSig',
    'invite.cardAgentSig',
    'handshake.cardAgentSig',
    'card-update.cardAgentSig',
    'ProofPack.signer.cardSig',
    'ProofPack.signer.cardAgentSig',
  ],
  // An ECDSA or ERC-1271 signature, 0x + even hex; the canonical rule is the EOA check's (04 §2.4.1).
  recordSignature: [
    'ProofPack.signature',
    'submitter.records[].signature',
    'submitter.receipts[].signature',
  ],
  uint256: [
    'Record.maxFee',
    'Record.nonce',
    'EIP3009.auth.value',
    'EIP3009.auth.validAfter',
    'EIP3009.auth.validBefore',
    'ProofStatus.fee.amount',
    'approval-request.action.context.fee.amount',
  ],
  nostrKey: [
    'envelope.from',
    'OwnerAction.owner',
    'CommitmentScope.counterparty.ownerKey',
    'nostr.eventId',
  ],
  bip340: [
    'envelope.sig',
    'SignedOwnerAction.sig',
    'handshake.cardPop',
    'handshake-ack.cardPop',
    'card-update.cardPop',
    'ProofPack.signer.cardPop',
  ],
  digest: [
    'approval-request.actionDigest',
    'approval.decide.params.actionDigest',
    'terms-body.termsHash',
    'terms.previousTermsHash',
    'CommitmentScope.termsHash',
    'payload.files[].plaintextSha256',
    'terms.deliverables[].plaintextSha256',
    'payload.files[].ciphertextSha256',
    'drop-commit.ciphertextSha256',
    'ProofPack.ownerApproval.policyHash',
    'handshake.inviterCardHash',
    'contact.check.params.pairingDigest',
    'tool.termsHash',
  ],
  base64url16: [
    'envelope.id',
    'envelope.thread',
    'envelope.recipients[].kid',
    'payload.replyTo',
    'proof.envelopeId',
    'CommitmentScope.answers.envelopeId',
    'CommitmentScope.thread',
    'CommitmentScope.termsId',
    'terms.termsId',
    'invite.inviteId',
    'handshake.inviteId',
    'handshake-ack.inviteId',
    'handshake-ack.handshakeId',
    'OwnerAction.nonce',
    'drop-request.nonce',
    'tool.envelopeId',
  ],
  base64url32: [
    'envelope.recipients[].enc',
    'payload.files[].fileKey',
    'invite.secret',
    'invite.codeCommit',
    'handshake.proof',
    'handshake.codeNonce',
    'handshake.codeCommit',
    'handshake-ack.codeReveal',
    'ProofPack.disclosure.contentKey',
    'envelope.aead.kc',
  ],
  other: [
    'envelope.recipients[].wk',
    'envelope.aead.iv',
    'envelope.aead.ct',
    'payload.files[].inline',
    'approvalId',
  ],
} as const;

const ALL_SPEC_PATHS: readonly string[] = Object.values(SPEC_PATHS).flat();

const fill = (bytes: number, byte = 0xab): Uint8Array => new Uint8Array(bytes).fill(byte);
const counting = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i & 0xff);
const hex = (bytes: Uint8Array): string => bytesToHex(bytes);
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const b64 = (bytes: Uint8Array): string => {
  // Independent of the package's own encoder: RFC 4648 §5 by hand.
  const A = B64_ALPHABET;
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 6 !== 0) bits += '0';
  let out = '';
  for (let i = 0; i < bits.length; i += 6) out += A.charAt(parseInt(bits.slice(i, i + 6), 2));
  return out;
};

const ADDRESS = '0x' + hex(counting(20));
const BYTES32 = '0x' + hex(counting(32));
const KEY = hex(counting(32));
const SIG64 = hex(counting(64));
const word = (n: bigint): string => n.toString(16).padStart(64, '0');
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const ecdsa = (r: bigint, s: bigint, v: number): string =>
  `0x${word(r)}${word(s)}${v.toString(16).padStart(2, '0')}`;
const LOW_S_SIG = ecdsa(1n, 2n, 27);

const decodeHex = (path: EncodingPath, value: unknown): string | null => {
  const bytes = decodeAtPath(path, value);
  return bytes === null ? null : hex(bytes);
};

describe('the path table', () => {
  it('holds exactly the 04 §2.4.1 schema paths', () => {
    expect([...ENCODING_PATHS].sort()).toEqual([...ALL_SPEC_PATHS].sort());
    expect(new Set(ENCODING_PATHS).size).toBe(ENCODING_PATHS.length);
  });

  it('isEncodingPath knows each path and nothing else', () => {
    for (const path of ALL_SPEC_PATHS) expect(isEncodingPath(path), path).toBe(true);
    for (const other of ['', 'nonce', 'sig', 'id', 'Record', 'toString', '__proto__', 1, null]) {
      expect(isEncodingPath(other), String(other)).toBe(false);
    }
  });

  it('cannot be extended or edited by a caller', () => {
    expect(Object.isFrozen(ENCODING_PATHS)).toBe(true);
  });
});

describe('decodeAtPath: canonical forms decode to their bytes', () => {
  it.each(SPEC_PATHS.address)('%s: 0x + 40 hex', (path) => {
    expect(decodeHex(path, ADDRESS)).toBe(ADDRESS.slice(2));
  });

  it.each(SPEC_PATHS.bytes32)('%s: 0x + 64 hex', (path) => {
    expect(decodeHex(path, BYTES32)).toBe(BYTES32.slice(2));
  });

  it.each([...SPEC_PATHS.ecdsa, ...SPEC_PATHS.recordSignature])('%s: canonical ECDSA', (path) => {
    expect(decodeHex(path, LOW_S_SIG)).toBe(LOW_S_SIG.slice(2));
    const halfN = ecdsa(N - 1n, N >> 1n, 28);
    expect(decodeHex(path, halfN)).toBe(halfN.slice(2));
  });

  it.each(SPEC_PATHS.uint256)('%s: decimal string as 32 big-endian bytes', (path) => {
    expect(decodeHex(path, '0')).toBe('00'.repeat(32));
    expect(decodeHex(path, '1500000')).toBe(word(1500000n));
    const max = (1n << 256n) - 1n;
    expect(decodeHex(path, max.toString())).toBe('ff'.repeat(32));
  });

  it.each(SPEC_PATHS.nostrKey)('%s: bare 64 hex', (path) => {
    expect(decodeHex(path, KEY)).toBe(KEY);
  });

  it.each(SPEC_PATHS.bip340)('%s: bare 128 hex', (path) => {
    expect(decodeHex(path, SIG64)).toBe(SIG64);
  });

  it.each(SPEC_PATHS.digest)('%s: bare 64 hex', (path) => {
    expect(decodeHex(path, KEY)).toBe(KEY);
  });

  it.each(SPEC_PATHS.base64url16)('%s: base64url of 16 bytes', (path) => {
    const bytes = counting(16);
    expect(decodeHex(path, b64(bytes))).toBe(hex(bytes));
  });

  it.each(SPEC_PATHS.base64url32)('%s: base64url of 32 bytes', (path) => {
    const bytes = fill(32, 0xfb);
    expect(decodeHex(path, b64(bytes))).toBe(hex(bytes));
  });

  it('envelope.recipients[].wk: 48 bytes; aead.iv: 12 bytes', () => {
    expect(decodeHex('envelope.recipients[].wk', b64(counting(48)))).toBe(hex(counting(48)));
    expect(decodeHex('envelope.aead.iv', b64(counting(12)))).toBe(hex(counting(12)));
  });

  it('envelope.aead.ct: at least the 16-byte tag', () => {
    expect(decodeHex('envelope.aead.ct', b64(counting(16)))).toBe(hex(counting(16)));
    expect(decodeHex('envelope.aead.ct', b64(counting(1000)))).toBe(hex(counting(1000)));
  });

  it('payload.files[].inline: 0 to 12 288 bytes', () => {
    expect(decodeHex('payload.files[].inline', '')).toBe('');
    expect(decodeHex('payload.files[].inline', b64(counting(12288)))).toBe(hex(counting(12288)));
  });

  it('approvalId: the 16 bytes after apr_', () => {
    const bytes = counting(16);
    expect(decodeHex('approvalId', `apr_${b64(bytes)}`)).toBe(hex(bytes));
  });

  it.each(SPEC_PATHS.recordSignature)('%s: an ERC-1271 signature of another length', (path) => {
    expect(decodeHex(path, `0x${hex(counting(96))}`)).toBe(hex(counting(96)));
    expect(decodeHex(path, `0x${hex(counting(1))}`)).toBe('00');
  });

  it('returns fresh bytes each call', () => {
    const a = decodeAtPath('OwnerAction.owner', KEY);
    expect(a).not.toBeNull();
    a?.fill(0);
    expect(decodeHex('OwnerAction.owner', KEY)).toBe(KEY);
  });
});

describe('decodeAtPath: every non-canonical form is rejected, never normalised', () => {
  const upper = (s: string) => s.toUpperCase().replace(/^0X/, '0x');

  it.each([...SPEC_PATHS.address, ...SPEC_PATHS.bytes32])('%s', (path) => {
    const good = SPEC_PATHS.address.includes(path as never) ? ADDRESS : BYTES32;
    for (const bad of [
      upper(good),
      good.slice(2), // no 0x
      `0X${good.slice(2)}`,
      good.slice(0, -1),
      `${good}0`,
      `${good}00`,
      ` ${good}`,
      `${good}\n`,
      good.replace(/.$/, 'g'),
      '',
      '0x',
    ]) {
      expect(decodeAtPath(path, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('EIP-55 checksummed address', () => {
    expect(
      decodeAtPath('OwnerAction.agent', '0x0180EC93Ae3eFFD2535292DD293F5e4bB3ea2876'),
    ).toBeNull();
  });

  it.each([...SPEC_PATHS.nostrKey, ...SPEC_PATHS.digest, ...SPEC_PATHS.bip340])('%s', (path) => {
    const good = SPEC_PATHS.bip340.includes(path as never) ? SIG64 : KEY;
    for (const bad of [
      `0x${good}`,
      good.toUpperCase(),
      good.slice(0, -1),
      good.slice(0, -2),
      `${good}00`,
      `${good} `,
      b64(counting(good.length / 2)),
      '',
    ]) {
      expect(decodeAtPath(path, bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it.each([...SPEC_PATHS.ecdsa])('%s: non-canonical ECDSA', (path) => {
    for (const bad of [
      ecdsa(1n, 2n, 0), // v 0
      ecdsa(1n, 2n, 1), // v 1
      ecdsa(1n, (N >> 1n) + 1n, 27), // high s
      ecdsa(0n, 2n, 27), // r = 0
      ecdsa(1n, 0n, 27), // s = 0
      ecdsa(N, 2n, 27), // r = n
      upper(LOW_S_SIG),
      LOW_S_SIG.slice(2),
    ]) {
      expect(decodeAtPath(path, bad), bad).toBeNull();
    }
  });

  // 04 §2.4.1: a Record, Receipt or proof-pack signature may be an ERC-1271 one in any form, 65 bytes
  // included; only ECDSA recovery (the EOA path, in the verifier) needs the canonical form, as in the
  // Notary's SignatureChecker. The JSON form is still strict.
  it.each([...SPEC_PATHS.recordSignature])(
    '%s: a 65-byte non-canonical form is a valid ERC-1271 form; the JSON form stays strict',
    (path) => {
      for (const form of [
        ecdsa(1n, 2n, 0), // v 0 (a Safe)
        ecdsa(1n, 2n, 1), // v 1
        ecdsa(1n, (N >> 1n) + 1n, 27), // high s
        ecdsa(0n, 2n, 27), // r = 0
      ]) {
        expect(decodeAtPath(path, form), form).not.toBeNull();
      }
      for (const bad of [upper(LOW_S_SIG), LOW_S_SIG.slice(2), `${LOW_S_SIG}0`, '0x']) {
        expect(decodeAtPath(path, bad), bad).toBeNull();
      }
    },
  );

  it.each(SPEC_PATHS.ecdsa)('%s: only 65 bytes (no ERC-1271 form)', (path) => {
    expect(decodeAtPath(path, LOW_S_SIG.slice(0, -2))).toBeNull(); // 64 bytes
    expect(decodeAtPath(path, `0x${hex(counting(96))}`)).toBeNull();
  });

  it.each(SPEC_PATHS.recordSignature)('%s: ERC-1271 needs non-empty, even hex', (path) => {
    expect(decodeAtPath(path, '0x')).toBeNull();
    expect(decodeAtPath(path, LOW_S_SIG.slice(0, -1))).toBeNull();
    expect(decodeAtPath(path, `0x${'AB'.repeat(96)}`)).toBeNull();
    expect(decodeAtPath(path, `0x${'00'.repeat(4097)}`)).toBeNull();
  });

  it.each(SPEC_PATHS.uint256)('%s', (path) => {
    for (const bad of [
      '',
      '01500',
      '+1500',
      '-1',
      '-0',
      '1500.0',
      '1e3',
      '0x5dc',
      ' 1500',
      '1500 ',
      (1n << 256n).toString(),
      '9'.repeat(79),
    ]) {
      expect(decodeAtPath(path, bad), bad).toBeNull();
    }
  });

  it.each([...SPEC_PATHS.base64url16, ...SPEC_PATHS.base64url32])('%s', (path) => {
    const n = SPEC_PATHS.base64url16.includes(path as never) ? 16 : 32;
    const good = b64(counting(n));
    // The same length with a non-zero unused bit in the last character (a second spelling).
    const lastNonZeroBits =
      good.slice(0, -1) + B64_ALPHABET.charAt(B64_ALPHABET.indexOf(good.slice(-1)) | 1);
    for (const bad of [
      `${good}==`,
      `${good}=`,
      good.replace(/[A-Za-z0-9]/, '+'),
      good.replace(/[A-Za-z0-9]/, '/'),
      `${good.slice(0, 5)} ${good.slice(5)}`,
      b64(counting(n - 1)),
      b64(counting(n + 1)),
      lastNonZeroBits,
      hex(counting(n)),
      `0x${hex(counting(n))}`,
    ]) {
      expect(decodeAtPath(path, bad), bad).toBeNull();
    }
  });

  it('fixed and bounded base64url lengths', () => {
    expect(decodeAtPath('envelope.recipients[].wk', b64(counting(47)))).toBeNull();
    expect(decodeAtPath('envelope.recipients[].wk', b64(counting(49)))).toBeNull();
    expect(decodeAtPath('envelope.aead.iv', b64(counting(11)))).toBeNull();
    expect(decodeAtPath('envelope.aead.iv', b64(counting(13)))).toBeNull();
    expect(decodeAtPath('envelope.aead.ct', b64(counting(15)))).toBeNull();
    expect(decodeAtPath('envelope.aead.ct', '')).toBeNull();
    expect(decodeAtPath('payload.files[].inline', b64(counting(12289)))).toBeNull();
  });

  it('approvalId: exact prefix and 16 canonical bytes', () => {
    const id = b64(counting(16));
    for (const bad of [
      id,
      `APR_${id}`,
      `apr-${id}`,
      `apr_${id}==`,
      `apr_${b64(counting(15))}`,
      `apr_${b64(counting(17))}`,
      `apr_${id.slice(0, -1)}${B64_ALPHABET.charAt(B64_ALPHABET.indexOf(id.slice(-1)) | 1)}`,
      ` apr_${id}`,
    ]) {
      expect(decodeAtPath('approvalId', bad), bad).toBeNull();
    }
  });

  it('the path decides, not the value: the same bytes in another class are rejected', () => {
    expect(decodeAtPath('AgentCard.ownerNostr', KEY)).toBeNull(); // card key without 0x
    expect(decodeAtPath('OwnerAction.owner', BYTES32)).toBeNull(); // owner with 0x
    expect(decodeAtPath('proof.recordId', b64(counting(32)))).toBeNull(); // base64url recordId
    expect(decodeAtPath('proof.salt', b64(counting(32)))).toBeNull();
    expect(decodeAtPath('OwnerAction.nonce', '1500')).toBeNull(); // the decimal nonce of a Record
    expect(decodeAtPath('Record.nonce', b64(counting(16)))).toBeNull(); // the base64url nonce
  });

  it('never throws on hostile input; a path outside the table decodes nothing', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      1,
      1n,
      true,
      {},
      [],
      [ADDRESS],
      Symbol('x'),
      () => ADDRESS,
      new String(ADDRESS),
      { toString: () => ADDRESS },
    ];
    for (const path of ALL_SPEC_PATHS as EncodingPath[]) {
      for (const value of hostile) expect(decodeAtPath(path, value)).toBeNull();
    }
    for (const path of ['nonce', 'toString', '__proto__', 'constructor', '']) {
      expect(decodeAtPath(path as EncodingPath, ADDRESS)).toBeNull();
    }
  });
});

describe('equalAtPaths: compare bytes, never strings', () => {
  it('the same key in its card form and its Nostr form is equal', () => {
    const card = { path: 'AgentCard.ownerNostr', value: `0x${KEY}` } as const;
    expect(equalAtPaths({ path: 'OwnerAction.owner', value: KEY }, card)).toBe(true);
    expect(
      equalAtPaths(
        { path: 'envelope.from', value: KEY },
        { ...card, path: 'AgentCard.agentNostr' },
      ),
    ).toBe(true);
    expect(equalAtPaths({ path: 'CommitmentScope.counterparty.ownerKey', value: KEY }, card)).toBe(
      true,
    );
  });

  it('different bytes are not equal; different lengths are not equal', () => {
    const other = hex(fill(32, 0x11));
    expect(
      equalAtPaths(
        { path: 'OwnerAction.owner', value: other },
        { path: 'AgentCard.ownerNostr', value: `0x${KEY}` },
      ),
    ).toBe(false);
    expect(
      equalAtPaths(
        { path: 'AgentCard.agentEvm', value: ADDRESS },
        { path: 'Record.envelopeHash', value: BYTES32 },
      ),
    ).toBe(false);
  });

  it('either side failing its own parse is a rejection (null), never a mismatch', () => {
    const owner = { path: 'OwnerAction.owner', value: KEY } as const;
    const card = { path: 'AgentCard.ownerNostr', value: `0x${KEY}` } as const;
    expect(equalAtPaths({ ...owner, value: `0x${KEY}` }, card)).toBeNull();
    expect(equalAtPaths(owner, { ...card, value: KEY })).toBeNull();
    expect(
      equalAtPaths(
        { path: 'OwnerAction.agent', value: ADDRESS.toUpperCase().replace('0X', '0x') },
        { path: 'AgentCard.agentEvm', value: ADDRESS },
      ),
    ).toBeNull();
    expect(equalAtPaths({ path: 'nonce' as EncodingPath, value: KEY }, owner)).toBeNull();
  });

  it('an address in two schemas compares equal', () => {
    expect(
      equalAtPaths(
        { path: 'contact.check.params.contact', value: ADDRESS },
        { path: 'AgentCard.agentEvm', value: ADDRESS },
      ),
    ).toBe(true);
  });
});
