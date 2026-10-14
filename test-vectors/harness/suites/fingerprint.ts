// Suite `fingerprint` (M1-1b): 04 §2.9 owner and agent fingerprints through @agentlink/crypto.
// Inputs are the card's `0x` values, decoded with the strict decoder; outputs are the digest and
// its short, long and domain-claim display forms.
import {
  agentFingerprint,
  decodeHex0x,
  formatFingerprint,
  ownerFingerprint,
} from '@agentlink/crypto';
import { bytesToHex } from '../hex';
import type { SuiteModule } from '../suite';

type FingerprintInput =
  | { op: 'ownerFingerprint'; ownerEvm: string; ownerNostr: string; ownerEnc: string }
  | { op: 'agentFingerprint'; agentId: string };

function parseInput(input: unknown): FingerprintInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  if (i?.op === 'ownerFingerprint' && str('ownerEvm') && str('ownerNostr') && str('ownerEnc')) {
    return i as FingerprintInput;
  }
  if (i?.op === 'agentFingerprint' && str('agentId')) return i as FingerprintInput;
  throw new TypeError('fingerprint: input does not match any op of case.schema.json');
}

function digestOf(input: FingerprintInput): Uint8Array {
  if (input.op === 'agentFingerprint') {
    return agentFingerprint(decodeHex0x(input.agentId, { length: 20 }));
  }
  return ownerFingerprint(
    decodeHex0x(input.ownerEvm, { length: 20 }),
    decodeHex0x(input.ownerNostr, { length: 32 }),
    decodeHex0x(input.ownerEnc, { length: 32 }),
  );
}

export const fingerprint: SuiteModule = {
  evaluate(testCase) {
    const digest = digestOf(parseInput(testCase.input));
    return Promise.resolve([
      { field: 'digest', actual: bytesToHex(digest) },
      { field: 'short', actual: formatFingerprint(digest, 'short') },
      { field: 'long', actual: formatFingerprint(digest, 'long') },
      { field: 'domainClaimFp', actual: formatFingerprint(digest, 'domainClaim') },
    ]);
  },
};
