// Suite `fingerprint` (M1-1b; sender code M1-1-sc): 04 §2.9 owner and agent fingerprints and the
// sender code through @4thtech-io/crypto. Card inputs are `0x` values and the sender's `from` is bare
// hex, each decoded with the strict decoder; outputs are the digest and its display forms (a sender
// code has the short form only).
import {
  agentFingerprint,
  decodeHex,
  decodeHex0x,
  formatFingerprint,
  ownerFingerprint,
  senderCode,
} from '@4thtech-io/crypto';
import { bytesToHex } from '../hex';
import type { SuiteModule } from '../suite';

type FingerprintInput =
  | { op: 'ownerFingerprint'; ownerEvm: string; ownerNostr: string; ownerEnc: string }
  | { op: 'agentFingerprint'; agentId: string }
  | { op: 'senderCode'; from: string };

function parseInput(input: unknown): FingerprintInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  if (i?.op === 'ownerFingerprint' && str('ownerEvm') && str('ownerNostr') && str('ownerEnc')) {
    return i as FingerprintInput;
  }
  if (i?.op === 'agentFingerprint' && str('agentId')) return i as FingerprintInput;
  if (i?.op === 'senderCode' && str('from')) return i as FingerprintInput;
  throw new TypeError('fingerprint: input does not match any op of case.schema.json');
}

function digestOf(input: FingerprintInput): Uint8Array {
  if (input.op === 'agentFingerprint') {
    return agentFingerprint(decodeHex0x(input.agentId, { length: 20 }));
  }
  if (input.op === 'senderCode') return senderCode(decodeHex(input.from, { length: 32 }));
  return ownerFingerprint(
    decodeHex0x(input.ownerEvm, { length: 20 }),
    decodeHex0x(input.ownerNostr, { length: 32 }),
    decodeHex0x(input.ownerEnc, { length: 32 }),
  );
}

export const fingerprint: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    const digest = digestOf(input);
    if (input.op === 'senderCode') {
      return Promise.resolve([
        { field: 'digest', actual: bytesToHex(digest) },
        { field: 'short', actual: formatFingerprint(digest, 'short') },
      ]);
    }
    return Promise.resolve([
      { field: 'digest', actual: bytesToHex(digest) },
      { field: 'short', actual: formatFingerprint(digest, 'short') },
      { field: 'long', actual: formatFingerprint(digest, 'long') },
      { field: 'domainClaimFp', actual: formatFingerprint(digest, 'domainClaim') },
    ]);
  },
};
