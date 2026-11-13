// Suite `desktop-update` (UPD-1): signed desktop update manifests, format v2, one pinned update key
// (08 §8, D-145 (5); owner decision 2026-11-13), through @4thtech-io/crypto only. The BIP-340 message is taggedHash(tag, JCS(document without
// `sig`)); `valid` says whether the document's `sig` verifies under `signer`. The desktop app's own
// verdicts on the same documents are checked in apps/desktop/test/unit/update-vectors.test.ts.
import { CryptoInputError, bip340Verify, canonicalizeToBytes, taggedHash } from '@4thtech-io/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

interface DesktopUpdateInput {
  op: 'desktopUpdateSignature';
  tag: string;
  document: Record<string, unknown>;
  signer: string;
}

function parseInput(input: unknown): DesktopUpdateInput {
  const i = input as Record<string, unknown> | null;
  const doc = i?.['document'];
  if (
    i?.['op'] !== 'desktopUpdateSignature' ||
    typeof i['tag'] !== 'string' ||
    typeof i['signer'] !== 'string' ||
    typeof doc !== 'object' ||
    doc === null ||
    Array.isArray(doc) ||
    typeof (doc as Record<string, unknown>)['sig'] !== 'string'
  ) {
    throw new TypeError('desktop-update: input does not match case.schema.json');
  }
  return i as unknown as DesktopUpdateInput;
}

export const desktopUpdate: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    const body = Object.fromEntries(Object.entries(input.document).filter(([k]) => k !== 'sig'));
    const message = taggedHash(input.tag, canonicalizeToBytes(body));
    let valid: boolean;
    try {
      valid = bip340Verify(
        hexToBytes(input.signer),
        message,
        hexToBytes(input.document['sig'] as string),
      );
    } catch (error) {
      if (!(error instanceof CryptoInputError)) throw error;
      valid = false;
    }
    return Promise.resolve([
      { field: 'message', actual: bytesToHex(message) },
      { field: 'valid', actual: valid ? 'true' : 'false' },
    ]);
  },
};
