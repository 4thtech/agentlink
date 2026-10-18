// Suite `bip340` (M1-1b): BIP-340 Schnorr through @4thtech-io/crypto. `sign` derives the x-only
// public key and signs with the given aux randomness; `verify` reports accept or reject. A refusal
// by the code under test (CryptoInputError) counts as reject; any other error fails the case.
import { CryptoInputError, bip340Verify } from '@4thtech-io/crypto';
import { bip340PublicKey, bip340Sign } from '@4thtech-io/crypto/keystore';
import { bytesToHex, hexToBytes } from '../hex';
import type { SuiteModule } from '../suite';

type Bip340Input =
  | { op: 'sign'; secretKey: string; auxRand: string; message: string }
  | { op: 'verify'; publicKey: string; message: string; signature: string };

function parseInput(input: unknown): Bip340Input {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  if (i?.op === 'sign' && str('secretKey') && str('auxRand') && str('message')) {
    return i as Bip340Input;
  }
  if (i?.op === 'verify' && str('publicKey') && str('message') && str('signature')) {
    return i as Bip340Input;
  }
  throw new TypeError('bip340: input does not match any op of case.schema.json');
}

function verifyOutcome(publicKey: string, message: string, signature: string): string {
  try {
    const valid = bip340Verify(hexToBytes(publicKey), hexToBytes(message), hexToBytes(signature));
    return valid ? 'accept' : 'reject';
  } catch (error) {
    if (error instanceof CryptoInputError) return 'reject';
    throw error;
  }
}

export const bip340: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    if (input.op === 'verify') {
      const outcome = verifyOutcome(input.publicKey, input.message, input.signature);
      return Promise.resolve([{ field: 'outcome', actual: outcome }]);
    }
    const secretKey = hexToBytes(input.secretKey);
    const signature = bip340Sign(secretKey, hexToBytes(input.message), hexToBytes(input.auxRand));
    return Promise.resolve([
      { field: 'publicKey', actual: bytesToHex(bip340PublicKey(secretKey)) },
      { field: 'signature', actual: bytesToHex(signature) },
    ]);
  },
};
