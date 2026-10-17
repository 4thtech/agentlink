// Suite `prf-wrap` (M1-1k): the passkey PRF salt and wrap key (04 §2.3 step 3) and the owner seed
// blobs `ALKP` v1 (04 §2.3.1) and `ALKR` v1 (04 §2.3.2), D-82, through @agentlink/crypto. Seals with
// the vector's fixed nonce (and salt) go through the test seam; production seals draw fresh ones. An
// empty `expectedOwnerNostr` means the caller knows no expected owner. Recovery codes are encoded
// with the package's strict UTF-8 encoder and given to the code under test as bytes. A refusal by the
// code under test (CryptoInputError) is `outcome: reject`; any other error fails the case. Runs in
// every runtime: the console opens these blobs in the browser.
import { CryptoInputError, encodeUtf8, ownerPrfSalt, readPasskeyBlobHeader } from '@agentlink/crypto';
import {
  derivePrfWrapKey,
  openPasskeySeed,
  openRecoverySeed,
} from '@agentlink/crypto/keystore';
import {
  sealPasskeySeedWithNonce,
  sealRecoverySeedWithSaltAndNonce,
} from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type PrfWrapInput =
  | { op: 'prfSalt' }
  | { op: 'wrapKey'; prfOutput: string }
  | { op: 'sealPasskey'; prfOutput: string; seed: string; credentialId: string; nonce: string }
  | { op: 'openPasskey'; blob: string; prfOutput: string; expectedOwnerNostr: string }
  | { op: 'passkeyHeader'; blob: string }
  | {
      op: 'sealRecovery';
      code: string;
      seed: string;
      salt: string;
      nonce: string;
      memoryKiB: number;
      iterations: number;
      parallelism: number;
    }
  | {
      op: 'openRecovery';
      blob: string;
      code: string;
      source: 'prompt' | 'file';
      expectedOwnerNostr: string;
    };

const OPS = [
  'prfSalt',
  'wrapKey',
  'sealPasskey',
  'openPasskey',
  'passkeyHeader',
  'sealRecovery',
  'openRecovery',
];

function parseInput(input: unknown): PrfWrapInput {
  const i = input as Record<string, unknown> | null;
  if (typeof i?.op === 'string' && OPS.includes(i.op)) return i as unknown as PrfWrapInput;
  throw new TypeError('prf-wrap: input does not match any op of case.schema.json');
}

const expectedOwner = (hex: string) =>
  hex === '' ? {} : { expectedOwnerNostr: hexToBytes(hex) };

async function evaluateInput(input: PrfWrapInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'prfSalt':
      return [{ field: 'salt', actual: bytesToHex(ownerPrfSalt()) }];
    case 'wrapKey':
      return [
        { field: 'wrapKey', actual: bytesToHex(derivePrfWrapKey(hexToBytes(input.prfOutput))) },
      ];
    case 'sealPasskey': {
      const blob = await sealPasskeySeedWithNonce(
        hexToBytes(input.prfOutput),
        hexToBytes(input.nonce),
        hexToBytes(input.seed),
        hexToBytes(input.credentialId),
      );
      return [{ field: 'blob', actual: bytesToHex(blob) }];
    }
    case 'openPasskey': {
      const seed = await openPasskeySeed(
        hexToBytes(input.blob),
        hexToBytes(input.prfOutput),
        expectedOwner(input.expectedOwnerNostr),
      );
      return [{ field: 'seed', actual: bytesToHex(seed) }];
    }
    case 'passkeyHeader': {
      const header = readPasskeyBlobHeader(hexToBytes(input.blob));
      return [
        { field: 'ownerNostr', actual: bytesToHex(header.ownerNostr) },
        { field: 'credentialId', actual: bytesToHex(header.credentialId) },
      ];
    }
    case 'sealRecovery': {
      const blob = await sealRecoverySeedWithSaltAndNonce(
        encodeUtf8(input.code),
        hexToBytes(input.salt),
        hexToBytes(input.nonce),
        hexToBytes(input.seed),
        {
          memoryKiB: input.memoryKiB,
          iterations: input.iterations,
          parallelism: input.parallelism,
        },
      );
      return [{ field: 'blob', actual: bytesToHex(blob) }];
    }
    case 'openRecovery': {
      const seed = await openRecoverySeed(
        hexToBytes(input.blob),
        { secret: encodeUtf8(input.code), source: input.source },
        expectedOwner(input.expectedOwnerNostr),
      );
      return [{ field: 'seed', actual: bytesToHex(seed) }];
    }
  }
}

export const prfWrap: SuiteModule = {
  async evaluate(testCase) {
    const input = parseInput(testCase.input);
    try {
      return await evaluateInput(input);
    } catch (error) {
      if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
      throw error;
    }
  },
};
