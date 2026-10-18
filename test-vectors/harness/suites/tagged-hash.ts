// Suite `tagged-hash` (M1-1a): BIP-340 tagged hashes through @4thtech-io/crypto, under the protocol
// tags of 04 §3.1 and §2.5.1, the BIP-340 tags, and tags that differ only in case, version or script.
import { taggedHash } from '@4thtech-io/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

function parseInput(input: unknown): { tag: string; message: string } {
  const i = input as { op?: unknown; tag?: unknown; message?: unknown } | null;
  if (i?.op !== 'taggedHash' || typeof i.tag !== 'string' || typeof i.message !== 'string') {
    throw new TypeError('tagged-hash: input must be { op: "taggedHash", tag, message }');
  }
  return { tag: i.tag, message: i.message };
}

export const taggedHashSuite: SuiteModule = {
  evaluate(testCase) {
    const { tag, message } = parseInput(testCase.input);
    const hash = taggedHash(tag, hexToBytes(message));
    return Promise.resolve([{ field: 'hash', actual: bytesToHex(hash) }]);
  },
};
