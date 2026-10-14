// M1-1f: the pairing safety code (04 §3.6.1, G-28): codeCommit, the constant-time commitment check,
// the role-ordered transcript, pairingDigest and the 12-digit code. The cross-runtime vectors are in
// test-vectors/safety-code; the values below are its cases `commit`, `code`, `code-leading-zeros`,
// `code-top-of-range` and `labels-differ`.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  SAFETY_CODE_MODULUS,
  TAGS,
  checkSafetyCodeReveal,
  computeSafetyCode,
  decodeBase64url,
  encodeHex,
  randomBytes,
  safetyCodeCommit,
  safetyCodeForRole,
  taggedHash,
  type AgentCard,
} from './index.js';
import { pairingDigest, safetyCodeFromDigest, safetyCodeTranscript } from './safety-code.js';

const CARD_A: AgentCard = {
  version: 1,
  agentEvm: '0x15c14b7b9efa8b472098117166bd9022dd66741b',
  agentNostr: '0x841268044cd8e12643e4525379040e315d8a31c931c0190ffc4d71442ff1067b',
  agentEnc: '0xf74298822707783a9ae769922487a1741be695e70f726aaa22444b8fb77bb27f',
  ownerEvm: '0x964aa453070076cffa353d9347245eaf90ef1a4e',
  ownerNostr: '0xd2e32394495fc1c17c367278dc14bc68701900029d32e259f137429a8a7be475',
  ownerEnc: '0x8f7937bd52d24ae958b08c42b97e473f8835cb1a86b794bd69ef264aa234bf0d',
  nameHash: '0x46b70db2287dfe8fb1e6fceec6299e6f9867fd4b613acd17ab78e0756defced7',
  relaysHash: '0x75eb592ec8abdaf14bd4649714b9f0359d6d4a6a58e2298e574fdc3d5a8beb21',
  issuedAt: 1760000000,
  expiresAt: 1791536000,
  keyEpoch: 0,
};
const CARD_B: AgentCard = {
  version: 1,
  agentEvm: '0x39526d247a8fe8b32fa14adbf1c0a153581eccad',
  agentNostr: '0xe107560bbe04bddfea66672e374bac433220031bcc8504e95946c21fa2b0e9d3',
  agentEnc: '0xb910af96f76dd4d2d690c47eab2a8acaa34c91dc05d94c52e0b512d8df547c5c',
  ownerEvm: '0xa43c4437420a3e6665a5f887beae2de157a899f8',
  ownerNostr: '0x3ba473fabb76d07c72d2bd3926968480afa5833f35ecbdbfd84fa08834f90adb',
  ownerEnc: '0x46b168de7e999ef2dd4345102aca75f8563d6ae72496f8de2bbc4fa8f3b98e73',
  nameHash: '0xd165286e20e88cd162fc235e66720c8e409b3092db198f69ce4ed57fbc32c4e4',
  relaysHash: '0x75eb592ec8abdaf14bd4649714b9f0359d6d4a6a58e2298e574fdc3d5a8beb21',
  issuedAt: 1760000000,
  expiresAt: 1791536000,
  keyEpoch: 0,
};
const INVITE_ID = decodeBase64url('N0hlGVgsMkUizgcw-fSlCw');
const NONCE_A = decodeBase64url('XamIwTJRt-04zFaMzBxzZXMr2oE0iFcMhrNXdJII5f8');
const NONCE_B = decodeBase64url('t82VgOZ22XXOgm6j_5JiRgEs7fgqv5yQLtO6UJrwoPY');
const COMMIT = decodeBase64url('QYvAJnr8__u5ouwRlvd3fzFR2p1FcLOKEPb8JHyE7ao');

const baseInput = {
  inviterCard: CARD_A,
  inviteeCard: CARD_B,
  inviteId: INVITE_ID,
  nonceA: NONCE_A,
  nonceB: NONCE_B,
  codeCommit: COMMIT,
};

function refusedWith(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return;
  }
  throw new Error('expected a refusal');
}

describe('safety-code tags', () => {
  it('are the 04 §3.6.1 labels, distinct from each other and every other tag', () => {
    expect(TAGS.safetyCommit).toBe('agentlink/safety-commit/v1');
    expect(TAGS.safetyCode).toBe('agentlink/safety-code/v1');
    const tags = Object.values(TAGS);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('give different digests for the same input (vector labels-differ)', () => {
    const t = safetyCodeTranscript(baseInput);
    expect(encodeHex(taggedHash(TAGS.safetyCommit, t))).toBe(
      '62422293f0a54841fcc33660fe9af5184598d1ef58a28d98ed6838c422cbb9f3',
    );
    expect(encodeHex(pairingDigest(t))).toBe(
      'b74b96caa737285225f61cf98427b64a0ea39c0ef13bbcbb51770623282a2c74',
    );
  });
});

describe('codeCommit and the reveal check', () => {
  it('commits to inviteId ‖ nonceA (vector commit)', () => {
    expect(safetyCodeCommit(INVITE_ID, NONCE_A)).toEqual(COMMIT);
  });

  it('accepts the nonce that opens the commitment', () => {
    expect(checkSafetyCodeReveal(INVITE_ID, NONCE_A, COMMIT)).toBe(true);
  });

  it('refuses a codeReveal that does not open codeCommit', () => {
    expect(checkSafetyCodeReveal(INVITE_ID, NONCE_B, COMMIT)).toBe(false);
    const flipped = NONCE_A.slice();
    flipped[31] = (flipped[31] as number) ^ 1;
    expect(checkSafetyCodeReveal(INVITE_ID, flipped, COMMIT)).toBe(false);
  });

  it('refuses the right nonce under another inviteId', () => {
    const other = INVITE_ID.slice();
    other[0] = (other[0] as number) ^ 1;
    expect(checkSafetyCodeReveal(other, NONCE_A, COMMIT)).toBe(false);
  });

  it('refuses values of the wrong length (the parsers fix every length, 04 §3.6)', () => {
    refusedWith(() => safetyCodeCommit(INVITE_ID.subarray(1), NONCE_A), 'invalid_length');
    refusedWith(() => safetyCodeCommit(INVITE_ID, NONCE_A.subarray(1)), 'invalid_length');
    refusedWith(
      () => checkSafetyCodeReveal(INVITE_ID, NONCE_A, COMMIT.subarray(1)),
      'invalid_length',
    );
    refusedWith(
      () => checkSafetyCodeReveal(INVITE_ID, new Uint8Array(33), COMMIT),
      'invalid_length',
    );
  });
});

describe('transcript, digest and code', () => {
  it('matches vector code: T, pairingDigest, the integer and the shown code', () => {
    const result = computeSafetyCode(baseInput);
    expect(result.transcript.length).toBe(144);
    expect(encodeHex(result.transcript).slice(0, 64)).toBe(
      '1a7bdca7f3fa818e4f47d0be8e93ed34cba91f1cc10429bd23697464c11e1dc3',
    );
    expect(encodeHex(result.pairingDigest)).toBe(
      'b74b96caa737285225f61cf98427b64a0ea39c0ef13bbcbb51770623282a2c74',
    );
    expect(result.integer).toBe(13207816129327081554n);
    expect(result.code).toBe('1293 2708 1554');
  });

  it('keeps leading zeros (vector code-leading-zeros)', () => {
    const nonceB = decodeBase64url('hNQIgSoZNSXJwqMsaCpac-4MHR-q1IS2DXEk-w1mNk4');
    const result = computeSafetyCode({ ...baseInput, nonceB });
    expect(result.integer).toBe(10621774000041349858n);
    expect(result.code).toBe('0000 4134 9858');
  });

  it('reduces an integer in the biased top of the range (vector code-top-of-range)', () => {
    const nonceB = decodeBase64url('1Lr2gLd1OU1FUUyUqUGpGfP0huMj_B8sViYQm13Eshs');
    const result = computeSafetyCode({ ...baseInput, nonceB });
    expect(result.integer).toBe(18446744034703777095n);
    expect(result.integer >= SAFETY_CODE_MODULUS * ((1n << 64n) / SAFETY_CODE_MODULUS)).toBe(true);
    expect(result.code).toBe('0347 0377 7095');
  });

  it('hashes each card as sha256(JCS(card)): key order does not matter', () => {
    const reordered = Object.fromEntries(Object.entries(CARD_A).reverse());
    expect(computeSafetyCode({ ...baseInput, inviterCard: reordered }).code).toBe('1293 2708 1554');
  });

  it('refuses a card that is not in the strict card JSON form', () => {
    const upper = { ...CARD_B, agentNostr: CARD_B.agentNostr.toUpperCase().replace('0X', '0x') };
    refusedWith(() => computeSafetyCode({ ...baseInput, inviteeCard: upper }), 'invalid_card');
  });

  it('formats from a digest: first 8 bytes, big-endian, mod 10^12, three groups of four', () => {
    const digest = new Uint8Array(32);
    expect(safetyCodeFromDigest(digest)).toEqual({ integer: 0n, code: '0000 0000 0000' });
    digest.fill(0xff, 0, 8);
    expect(safetyCodeFromDigest(digest).integer).toBe((1n << 64n) - 1n);
    expect(safetyCodeFromDigest(digest).code).toBe('0737 0955 1615');
    refusedWith(() => safetyCodeFromDigest(new Uint8Array(31)), 'invalid_length');
    refusedWith(() => pairingDigest(new Uint8Array(143)), 'invalid_length');
  });
});

describe('roles (property test)', () => {
  it('inviter and invitee compute the same code from the same transcript; swapping roles changes it', () => {
    for (let i = 0; i < 64; i += 1) {
      const inviteId = randomBytes(16);
      const nonceA = randomBytes(32);
      const nonceB = randomBytes(32);
      const codeCommit = safetyCodeCommit(inviteId, nonceA);
      const shared = { inviteId, nonceA, nonceB, codeCommit };
      const atA = safetyCodeForRole({
        role: 'inviter',
        ownCard: CARD_A,
        peerCard: CARD_B,
        ...shared,
      });
      const atB = safetyCodeForRole({
        role: 'invitee',
        ownCard: CARD_B,
        peerCard: CARD_A,
        ...shared,
      });
      expect(atB.pairingDigest).toEqual(atA.pairingDigest);
      expect(atB.code).toBe(atA.code);
      const swapped = safetyCodeForRole({
        role: 'invitee',
        ownCard: CARD_A,
        peerCard: CARD_B,
        ...shared,
      });
      expect(swapped.pairingDigest).not.toEqual(atA.pairingDigest);
    }
  });

  it('a commitment opens only with its own nonce', () => {
    for (let i = 0; i < 64; i += 1) {
      const inviteId = randomBytes(16);
      const nonceA = randomBytes(32);
      const commit = safetyCodeCommit(inviteId, nonceA);
      expect(checkSafetyCodeReveal(inviteId, nonceA, commit)).toBe(true);
      expect(checkSafetyCodeReveal(inviteId, randomBytes(32), commit)).toBe(false);
    }
  });

  it('refuses an unknown role', () => {
    refusedWith(
      () =>
        safetyCodeForRole({
          role: 'both' as 'inviter',
          ownCard: CARD_A,
          peerCard: CARD_B,
          inviteId: INVITE_ID,
          nonceA: NONCE_A,
          nonceB: NONCE_B,
          codeCommit: COMMIT,
        }),
      'invalid_argument',
    );
  });
});

// IR-M1-1f-1 M-2: 04 §3.6.1 step 3. No digits without a codeReveal (nonceA) that opens codeCommit.
describe('the commitment check before any code (step 3)', () => {
  it('refuses a nonceA that does not open codeCommit, with no code', () => {
    refusedWith(() => computeSafetyCode({ ...baseInput, nonceA: NONCE_B }), 'commitment_mismatch');
    const otherInvite = INVITE_ID.slice();
    otherInvite[0] = (otherInvite[0] as number) ^ 1;
    refusedWith(
      () => computeSafetyCode({ ...baseInput, inviteId: otherInvite }),
      'commitment_mismatch',
    );
    const flipped = COMMIT.slice();
    flipped[0] = (flipped[0] as number) ^ 1;
    refusedWith(
      () => computeSafetyCode({ ...baseInput, codeCommit: flipped }),
      'commitment_mismatch',
    );
    for (const role of ['inviter', 'invitee'] as const) {
      refusedWith(
        () =>
          safetyCodeForRole({
            role,
            ownCard: CARD_A,
            peerCard: CARD_B,
            inviteId: INVITE_ID,
            nonceA: NONCE_B,
            nonceB: NONCE_B,
            codeCommit: COMMIT,
          }),
        'commitment_mismatch',
      );
    }
  });

  it('requires codeCommit: a missing or malformed commitment is refused', () => {
    const withoutCommit: Partial<typeof baseInput> = { ...baseInput };
    delete withoutCommit.codeCommit;
    refusedWith(
      () => computeSafetyCode(withoutCommit as unknown as typeof baseInput),
      'invalid_argument',
    );
    refusedWith(
      () => computeSafetyCode({ ...baseInput, codeCommit: COMMIT.subarray(1) }),
      'invalid_length',
    );
  });
});
