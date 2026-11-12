// Suite `alkh` (DESK-D12a): the native presence wrap `ALKH` v1 (04 §2.3.4, D-145 phase 2), through
// @4thtech-io/crypto. Seals with the vector's fixed nonce go through the test seam; production seals
// draw a fresh one. The native secrets stand in for what the macOS and Windows helpers release (an
// ECDH X coordinate, a PKCS#1 v1.5 signature). An empty `expectedOwnerNostr` and `expectedKind` 0
// mean the caller knows none. `crossOpen` gives an ALKH blob to the ALKP, ALKR and ALKO readers;
// `helperRecord` / `readHelperRecord` are the DESK-D12b helper record v1. A
// refusal by the code under test (CryptoInputError) is `outcome: reject`; any other error fails the
// case. Runs in every runtime.
import {
  CryptoInputError,
  encodeNativeHelperRecord,
  encodeUtf8,
  readNativeBlobHeader,
  readNativeHelperRecord,
} from '@4thtech-io/crypto';
import {
  deriveNativeWrapKey,
  openNativeSeed,
  openOwnerSeedWithoutCard,
  openPasskeySeed,
  openRecoverySeed,
  type NativePresenceKind,
} from '@4thtech-io/crypto/keystore';
import { sealNativeSeedWithNonce } from '@4thtech-io/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

interface Credential {
  kind: NativePresenceKind;
  nativeSecret: string;
  credentialId: string;
  credentialPublicKey: string;
  challenge: string;
}

type AlkhInput =
  | ({ op: 'wrapKey'; ownerNostr: string } & Credential)
  | ({ op: 'sealNative'; seed: string; nonce: string } & Credential)
  | {
      op: 'openNative';
      blob: string;
      nativeSecret: string;
      expectedOwnerNostr: string;
      expectedKind: 0 | NativePresenceKind;
    }
  | { op: 'nativeHeader'; blob: string }
  | {
      op: 'helperRecord';
      kind: NativePresenceKind;
      credentialId: string;
      credentialPublicKey: string;
      challenge: string;
    }
  | { op: 'readHelperRecord'; kind: NativePresenceKind; record: string }
  | { op: 'crossOpen'; reader: 'passkey' | 'recovery' | 'owner'; blob: string; secret: string };

const OPS = [
  'wrapKey',
  'sealNative',
  'openNative',
  'nativeHeader',
  'helperRecord',
  'readHelperRecord',
  'crossOpen',
];

function parseInput(input: unknown): AlkhInput {
  const i = input as Record<string, unknown> | null;
  if (typeof i?.op === 'string' && OPS.includes(i.op)) return i as unknown as AlkhInput;
  throw new TypeError('alkh: input does not match any op of case.schema.json');
}

const credential = (input: Credential) => ({
  kind: input.kind,
  nativeSecret: hexToBytes(input.nativeSecret),
  credentialId: hexToBytes(input.credentialId),
  credentialPublicKey: hexToBytes(input.credentialPublicKey),
  challenge: hexToBytes(input.challenge),
});

async function crossOpen(input: Extract<AlkhInput, { op: 'crossOpen' }>): Promise<Uint8Array> {
  const blob = hexToBytes(input.blob);
  switch (input.reader) {
    case 'passkey':
      return openPasskeySeed(blob, hexToBytes(input.secret));
    case 'recovery':
      return openRecoverySeed(blob, { secret: encodeUtf8(input.secret), source: 'prompt' });
    case 'owner':
      return openOwnerSeedWithoutCard(
        blob,
        { secret: encodeUtf8(input.secret), source: 'prompt' },
        { fileKeystoreMachine: true },
      );
  }
}

async function evaluateInput(input: AlkhInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'wrapKey': {
      const key = deriveNativeWrapKey({
        ...credential(input),
        ownerNostr: hexToBytes(input.ownerNostr),
      });
      return [{ field: 'wrapKey', actual: bytesToHex(key) }];
    }
    case 'sealNative': {
      const blob = await sealNativeSeedWithNonce(
        { ...credential(input), seed: hexToBytes(input.seed) },
        hexToBytes(input.nonce),
      );
      return [{ field: 'blob', actual: bytesToHex(blob) }];
    }
    case 'openNative': {
      const seed = await openNativeSeed(hexToBytes(input.blob), hexToBytes(input.nativeSecret), {
        ...(input.expectedOwnerNostr === ''
          ? {}
          : { expectedOwnerNostr: hexToBytes(input.expectedOwnerNostr) }),
        ...(input.expectedKind === 0 ? {} : { expectedKind: input.expectedKind }),
      });
      return [{ field: 'seed', actual: bytesToHex(seed) }];
    }
    case 'nativeHeader': {
      const header = readNativeBlobHeader(hexToBytes(input.blob));
      return [
        { field: 'kind', actual: String(header.kind) },
        { field: 'ownerNostr', actual: bytesToHex(header.ownerNostr) },
        { field: 'credentialId', actual: bytesToHex(header.credentialId) },
        { field: 'credentialPublicKey', actual: bytesToHex(header.credentialPublicKey) },
        { field: 'challenge', actual: bytesToHex(header.challenge) },
      ];
    }
    case 'helperRecord': {
      const record = encodeNativeHelperRecord(input.kind, {
        credentialId: hexToBytes(input.credentialId),
        credentialPublicKey: hexToBytes(input.credentialPublicKey),
        challenge: hexToBytes(input.challenge),
      });
      return [{ field: 'record', actual: bytesToHex(record) }];
    }
    case 'readHelperRecord': {
      const read = readNativeHelperRecord(input.kind, hexToBytes(input.record));
      return [
        { field: 'credentialId', actual: bytesToHex(read.credentialId) },
        { field: 'credentialPublicKey', actual: bytesToHex(read.credentialPublicKey) },
        { field: 'challenge', actual: bytesToHex(read.challenge) },
      ];
    }
    case 'crossOpen': {
      const seed = await crossOpen(input);
      return [{ field: 'seed', actual: bytesToHex(seed) }];
    }
  }
}

export const alkh: SuiteModule = {
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
