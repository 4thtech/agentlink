// Suite `keystore-file` (M1-1f): 04 §2.8 `ALKS` v1 (file KeyStore) and `ALKO` v1 (owner seed wrap)
// through @agentlink/crypto. Text secrets are encoded with the package's strict UTF-8 encoder (a lone
// surrogate is refused, never replaced) and given to the code under test as bytes. Seals with the
// vector's fixed nonce go through the test seam; production seals draw a fresh nonce. A refusal by
// the code under test (CryptoInputError) is `outcome: reject`; any other error fails the case. Node
// only, as the vector file declares (04 §2.8 runtime table).
import { CryptoInputError, decodeHex0x, encodeUtf8 } from '@agentlink/crypto';
import {
  deriveKeystoreKek,
  normalizeSecret,
  openKeystoreFile,
  openOwnerSeed,
} from '@agentlink/crypto/keystore';
import { sealKeystoreFileWithNonce, sealOwnerSeedWithNonce } from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type Source = 'prompt' | 'file';
interface KdfFields {
  secretKind: number;
  secret: string;
  source: Source;
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}
type KeystoreFileInput =
  | { op: 'password'; secretKind: number; secret: string; source: Source }
  | { op: 'passwordBytes'; secretKind: number; secretBytes: string; source: Source }
  | ({ op: 'kek'; format: 'ALKS' | 'ALKO' } & KdfFields)
  | ({
      op: 'seal';
      nonce: string;
      agentId: string;
      entries: { name: string; value: string }[];
    } & KdfFields)
  | ({ op: 'sealAlko'; nonce: string; seed: string } & KdfFields)
  | { op: 'open'; file: string; secret: string; source: Source; expectedAgentId: string }
  | {
      op: 'openAlko';
      file: string;
      secret: string;
      source: Source;
      expectedOwner: { ownerEvm: string; ownerNostr: string };
      fileKeystoreMachine: boolean;
    };

const OPS = ['password', 'passwordBytes', 'kek', 'seal', 'sealAlko', 'open', 'openAlko'];

function parseInput(input: unknown): KeystoreFileInput {
  const i = input as Record<string, unknown> | null;
  if (typeof i?.op === 'string' && OPS.includes(i.op)) return i as unknown as KeystoreFileInput;
  throw new TypeError('keystore-file: input does not match any op of case.schema.json');
}

const params = (i: KdfFields) => ({
  memoryKiB: i.memoryKiB,
  iterations: i.iterations,
  parallelism: i.parallelism,
});
const kekOf = (format: 'ALKS' | 'ALKO', i: KdfFields) =>
  deriveKeystoreKek(
    format,
    { secret: encodeUtf8(i.secret), secretKind: i.secretKind as 1 | 2, source: i.source },
    hexToBytes(i.salt),
    params(i),
  );

async function evaluateInput(input: KeystoreFileInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'password':
    case 'passwordBytes': {
      const raw =
        input.op === 'password' ? encodeUtf8(input.secret) : hexToBytes(input.secretBytes);
      const password = normalizeSecret(raw, input.secretKind as 1 | 2, input.source);
      return [{ field: 'password', actual: bytesToHex(password) }];
    }
    case 'kek':
      return [{ field: 'kek', actual: bytesToHex((await kekOf(input.format, input)).kek) }];
    case 'seal': {
      const kek = await kekOf('ALKS', input);
      const entries = input.entries.map((e) => ({ name: e.name, value: hexToBytes(e.value) }));
      const file = await sealKeystoreFileWithNonce(
        kek,
        hexToBytes(input.nonce),
        input.agentId,
        entries,
      );
      return [{ field: 'file', actual: bytesToHex(file) }];
    }
    case 'sealAlko': {
      const kek = await kekOf('ALKO', input);
      const blob = await sealOwnerSeedWithNonce(kek, hexToBytes(input.nonce), hexToBytes(input.seed), {
        destination: 'local',
        fileKeystoreMachine: false,
      });
      return [{ field: 'file', actual: bytesToHex(blob) }];
    }
    case 'open': {
      const { entries } = await openKeystoreFile(
        hexToBytes(input.file),
        { secret: encodeUtf8(input.secret), source: input.source },
        input.expectedAgentId,
      );
      return [
        { field: 'entryNames', actual: entries.map((e) => e.name).join(',') },
        ...entries.map((e) => ({ field: `entry:${e.name}`, actual: bytesToHex(e.value) })),
      ];
    }
    case 'openAlko': {
      const seed = await openOwnerSeed(
        hexToBytes(input.file),
        { secret: encodeUtf8(input.secret), source: input.source },
        {
          ownerEvm: decodeHex0x(input.expectedOwner.ownerEvm, { length: 20 }),
          ownerNostr: decodeHex0x(input.expectedOwner.ownerNostr, { length: 32 }),
        },
        { fileKeystoreMachine: input.fileKeystoreMachine },
      );
      return [{ field: 'seed', actual: bytesToHex(seed) }];
    }
  }
}

export const keystoreFile: SuiteModule = {
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
