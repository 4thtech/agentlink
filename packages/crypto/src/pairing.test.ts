// M1-1f: the pairing proof (04 §3.6). proofKey = HKDF-SHA256(invite secret, "", "agentlink/v1/
// pairing-proof"); proof = HMAC-SHA256(proofKey, "agentlink-handshake" ‖ inviteId ‖ sha256(JCS(B's
// card))). The cross-runtime vectors (RFC 4231 and the byte-exact proof) are in test-vectors/pairing;
// these tests pin the API rules. Inputs are derived at run time, so no key material is committed.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  PAIRING_HANDSHAKE_LABEL,
  PAIRING_PROOF_INFO,
  agentCardJcsHash,
  canonicalizeToBytes,
  concatBytes,
  derivePairingProofKey,
  encodeUtf8,
  hkdfSha256,
  hmacSha256,
  pairingProof,
  sha256,
  verifyPairingProof,
  type AgentCard,
} from './index.js';

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
const INVITE = sha256(encodeUtf8('pairing.test/invite')).subarray(0, 16);
const LINK_SECRET = sha256(encodeUtf8('pairing.test/link'));

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

describe('hmacSha256', () => {
  it('is RFC 2104 HMAC with SHA-256 (RFC 4231 test case 2)', () => {
    const mac = hmacSha256(encodeUtf8('Jefe'), encodeUtf8('what do ya want for nothing?'));
    expect(Array.from(mac.subarray(0, 4))).toEqual([0x5b, 0xdc, 0xc1, 0x46]);
    expect(mac.length).toBe(32);
  });

  it('refuses non-byte input', () => {
    refusedWith(
      () => hmacSha256('k' as unknown as Uint8Array, new Uint8Array(1)),
      'invalid_argument',
    );
  });
});

describe('pairing proof', () => {
  it('pins the labels of 04 §3.6', () => {
    expect(PAIRING_PROOF_INFO).toBe('agentlink/v1/pairing-proof');
    expect(PAIRING_HANDSHAKE_LABEL).toBe('agentlink-handshake');
  });

  it('derives proofKey with HKDF-SHA256(secret, "", info, 32), never the raw secret', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    expect(proofKey).toEqual(
      hkdfSha256(LINK_SECRET, new Uint8Array(0), encodeUtf8(PAIRING_PROOF_INFO), 32),
    );
    expect(proofKey).not.toEqual(LINK_SECRET);
  });

  it('is HMAC over the 19-byte label, the 16 raw inviteId bytes and sha256(JCS(card))', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    const message = concatBytes(
      encodeUtf8('agentlink-handshake'),
      INVITE,
      sha256(canonicalizeToBytes(CARD_B)),
    );
    expect(message.length).toBe(19 + 16 + 32);
    expect(pairingProof(proofKey, INVITE, CARD_B)).toEqual(hmacSha256(proofKey, message));
    expect(agentCardJcsHash(CARD_B)).toEqual(message.subarray(35));
  });

  it('does not depend on the card key order (JCS)', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    const reordered = Object.fromEntries(Object.entries(CARD_B).reverse());
    expect(pairingProof(proofKey, INVITE, reordered)).toEqual(
      pairingProof(proofKey, INVITE, CARD_B),
    );
  });

  it('verifies the matching proof and refuses every other input', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    const proof = pairingProof(proofKey, INVITE, CARD_B);
    expect(verifyPairingProof(proofKey, INVITE, CARD_B, proof)).toBe(true);

    const otherKey = derivePairingProofKey(sha256(encodeUtf8('pairing.test/other')));
    expect(verifyPairingProof(otherKey, INVITE, CARD_B, proof)).toBe(false);
    const otherInvite = INVITE.slice();
    otherInvite[0] = (otherInvite[0] as number) ^ 1;
    expect(verifyPairingProof(proofKey, otherInvite, CARD_B, proof)).toBe(false);
    expect(verifyPairingProof(proofKey, INVITE, { ...CARD_B, keyEpoch: 1 }, proof)).toBe(false);
    const flipped = proof.slice();
    flipped[31] = (flipped[31] as number) ^ 0x80;
    expect(verifyPairingProof(proofKey, INVITE, CARD_B, flipped)).toBe(false);
    // A proof keyed with the raw secret instead of proofKey does not verify.
    const rawKeyed = hmacSha256(
      LINK_SECRET,
      concatBytes(encodeUtf8('agentlink-handshake'), INVITE, agentCardJcsHash(CARD_B)),
    );
    expect(verifyPairingProof(proofKey, INVITE, CARD_B, rawKeyed)).toBe(false);
  });

  it('refuses a proof that is not 32 bytes', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    const proof = pairingProof(proofKey, INVITE, CARD_B);
    expect(verifyPairingProof(proofKey, INVITE, CARD_B, proof.subarray(0, 31))).toBe(false);
    expect(
      verifyPairingProof(proofKey, INVITE, CARD_B, concatBytes(proof, new Uint8Array(1))),
    ).toBe(false);
  });

  it('refuses a secret, proofKey or inviteId of the wrong length', () => {
    refusedWith(() => derivePairingProofKey(new Uint8Array(31)), 'invalid_length');
    refusedWith(() => pairingProof(new Uint8Array(31), INVITE, CARD_B), 'invalid_length');
    refusedWith(
      () => pairingProof(derivePairingProofKey(LINK_SECRET), new Uint8Array(15), CARD_B),
      'invalid_length',
    );
  });

  it('refuses a card that is not in the strict card JSON form', () => {
    const proofKey = derivePairingProofKey(LINK_SECRET);
    const upper = { ...CARD_B, agentEvm: '0x' + CARD_B.agentEvm.slice(2).toUpperCase() };
    refusedWith(() => pairingProof(proofKey, INVITE, upper), 'invalid_card');
  });
});
