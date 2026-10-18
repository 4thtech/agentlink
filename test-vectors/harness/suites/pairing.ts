// Suite `pairing` (M1-1f): RFC 4231 HMAC-SHA256 and the 04 §3.6 pairing proof through
// @4thtech-io/crypto. Wire values (base64url `secret`, `inviteId`, `proof`) are decoded with the
// package's strict decoder; its refusals and the card parser's (CryptoInputError) are what
// `outcome: reject` measures, as is a proof that does not verify. Any other error fails the case.
import {
  CryptoInputError,
  agentCardJcsHash,
  decodeBase64url,
  derivePairingProofKey,
  encodeBase64url,
  hmacSha256,
  pairingProof,
  verifyPairingProof,
} from '@4thtech-io/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type PairingInput =
  | { op: 'hmacSha256'; key: string; data: string }
  | { op: 'pairingProof'; secret: string; inviteId: string; card: unknown }
  | { op: 'verifyPairingProof'; secret: string; inviteId: string; card: unknown; proof: string };

function parseInput(input: unknown): PairingInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  const obj = (key: string): boolean => typeof i?.[key] === 'object' && i[key] !== null;
  if (i?.op === 'hmacSha256' && str('key') && str('data')) return i as PairingInput;
  if (i?.op === 'pairingProof' && str('secret') && str('inviteId') && obj('card')) {
    return i as PairingInput;
  }
  if (
    i?.op === 'verifyPairingProof' &&
    str('secret') &&
    str('inviteId') &&
    obj('card') &&
    str('proof')
  ) {
    return i as PairingInput;
  }
  throw new TypeError('pairing: input does not match any op of case.schema.json');
}

function evaluateInput(input: PairingInput): readonly Comparison[] {
  switch (input.op) {
    case 'hmacSha256':
      return [
        {
          field: 'mac',
          actual: bytesToHex(hmacSha256(hexToBytes(input.key), hexToBytes(input.data))),
        },
      ];
    case 'pairingProof': {
      const proofKey = derivePairingProofKey(decodeBase64url(input.secret, { length: 32 }));
      const inviteId = decodeBase64url(input.inviteId, { length: 16 });
      return [
        { field: 'proofKey', actual: bytesToHex(proofKey) },
        { field: 'cardJcsSha256', actual: bytesToHex(agentCardJcsHash(input.card)) },
        { field: 'proof', actual: encodeBase64url(pairingProof(proofKey, inviteId, input.card)) },
      ];
    }
    case 'verifyPairingProof': {
      const proofKey = derivePairingProofKey(decodeBase64url(input.secret, { length: 32 }));
      const inviteId = decodeBase64url(input.inviteId, { length: 16 });
      const proof = decodeBase64url(input.proof);
      const ok = verifyPairingProof(proofKey, inviteId, input.card, proof);
      return [{ field: 'outcome', actual: ok ? 'accept' : 'reject' }];
    }
  }
}

export const pairing: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    try {
      return Promise.resolve(evaluateInput(input));
    } catch (error) {
      if (error instanceof CryptoInputError) {
        return Promise.resolve([{ field: 'outcome', actual: 'reject' }]);
      }
      throw error;
    }
  },
};
