// Suite `recovery-kit` (M1-9i-b): the recovery kit `ALKK` v1 (04 §2.3.3, D-115) through
// @4thtech-io/crypto. Seals with the vector's fixed code, salt, nonce prefix and chunk size go
// through the test seam (production seals draw a fresh code, salt and prefix); `openWithKek` opens
// with the vector's kek through the same seam, so the entry-list cases skip Argon2id. Store values go
// to in-memory sinks here (the restore's quarantined temporary files in production). An empty
// `expectedOwnerNostr` means the caller knows no expected owner. Codes are encoded with the package's
// strict UTF-8 encoder. A refusal by the code under test (CryptoInputError) is `outcome: reject`;
// any other error fails the case. `crossType` gives an ALKK kit to the ALKP, ALKR, ALKO, ALKS and
// ALF1 readers, which must each refuse it. Runs in every runtime.
import {
  CryptoInputError,
  decodeHex0x,
  encodeUtf8,
  openAlf1,
  readRecoveryKitHeader,
} from '@4thtech-io/crypto';
import {
  openKeystoreFile,
  openOwnerSeed,
  openPasskeySeed,
  openRecoveryKit,
  openRecoverySeed,
  type OpenedRecoveryKit,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto/keystore';
import {
  deriveRecoveryKitKek,
  openRecoveryKitWithKek,
  sealRecoveryKitWith,
} from '@4thtech-io/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type ItemName = 'seed' | 'store-key' | 'policy-version' | 'receipts-kept' | 'storage-mark';
type Kdf = { memoryKiB: number; iterations: number; parallelism: number };
type RecoveryKitInput =
  | ({ op: 'kek'; code: string; salt: string } & Kdf)
  | ({
      op: 'seal';
      code: string;
      salt: string;
      noncePrefix: string;
      chunkSize: number;
      ownerSeed: string;
      kitId: string;
      createdAt: number;
      contents: 'full' | 'identity';
      agents: {
        agentId: string;
        name: string;
        items: { name: ItemName; value: string }[];
        store: string;
      }[];
    } & Kdf)
  | { op: 'open'; kit: string; code: string; source: 'prompt' | 'file'; expectedOwnerNostr: string }
  | { op: 'openWithKek'; kit: string; kek: string }
  | { op: 'header'; kit: string }
  | {
      op: 'crossType';
      reader: 'ALKP' | 'ALKR' | 'ALKO' | 'ALKS' | 'ALF1';
      blob: string;
      code: string;
      key: string;
      agentId: string;
      ownerEvm: string;
      ownerNostr: string;
    };

const OPS = ['kek', 'seal', 'open', 'openWithKek', 'header', 'crossType'];

function parseInput(input: unknown): RecoveryKitInput {
  const i = input as Record<string, unknown> | null;
  if (typeof i?.op === 'string' && OPS.includes(i.op)) return i as unknown as RecoveryKitInput;
  throw new TypeError('recovery-kit: input does not match any op of case.schema.json');
}

const kdfOf = (input: Kdf) => ({
  memoryKiB: input.memoryKiB,
  iterations: input.iterations,
  parallelism: input.parallelism,
});

/** In-memory store sinks, in kit order. */
function memorySinks() {
  const stores = new Map<RecoveryKitStoreSink, Uint8Array[]>();
  return {
    createStoreSink(): RecoveryKitStoreSink {
      const parts: Uint8Array[] = [];
      const sink: RecoveryKitStoreSink = {
        write(bytes) {
          parts.push(bytes);
        },
        discard() {
          stores.delete(sink);
        },
      };
      stores.set(sink, parts);
      return sink;
    },
    bytesOf(sink: RecoveryKitStoreSink): Uint8Array {
      const parts = stores.get(sink) ?? [];
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
  };
}

/** The opened kit as the vector lists it: every entry name in kit order and each value. */
function entriesOf(kit: OpenedRecoveryKit, store: (sink: RecoveryKitStoreSink) => Uint8Array) {
  const entries: [string, Uint8Array][] = [['owner/seed', kit.ownerSeed]];
  for (const agent of kit.agents) {
    for (const item of agent.items)
      entries.push([`agent/${agent.agentId}/item/${item.name}`, item.value]);
    entries.push([`agent/${agent.agentId}/store`, store(agent.store)]);
  }
  return entries;
}

async function evaluateOpen(
  open: (options: { createStoreSink(): RecoveryKitStoreSink }) => Promise<OpenedRecoveryKit>,
): Promise<readonly Comparison[]> {
  const sinks = memorySinks();
  const kit = await open({ createStoreSink: () => sinks.createStoreSink() });
  const entries: [string, Uint8Array][] = [
    ['manifest', kit.manifest],
    ...entriesOf(kit, (s) => sinks.bytesOf(s)),
  ];
  return [
    { field: 'entryNames', actual: entries.map(([name]) => name).join(',') },
    ...entries.map(([name, value]) => ({ field: `entry:${name}`, actual: bytesToHex(value) })),
  ];
}

async function evaluateInput(input: RecoveryKitInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'kek': {
      const kek = await deriveRecoveryKitKek(
        { secret: encodeUtf8(input.code), source: 'prompt' },
        hexToBytes(input.salt),
        kdfOf(input),
      );
      return [{ field: 'kek', actual: bytesToHex(kek) }];
    }
    case 'seal': {
      const parts: Uint8Array[] = [];
      await sealRecoveryKitWith(
        encodeUtf8(input.code),
        hexToBytes(input.salt),
        hexToBytes(input.noncePrefix),
        input.chunkSize,
        kdfOf(input),
        {
          ownerSeed: hexToBytes(input.ownerSeed),
          kitId: input.kitId,
          createdAt: input.createdAt,
          contents: input.contents,
          agents: input.agents.map((a) => {
            const store = hexToBytes(a.store);
            return {
              agentId: a.agentId,
              name: a.name,
              items: a.items.map((i) => ({ name: i.name, value: hexToBytes(i.value) })),
              store: { length: store.length, chunks: [store] },
            };
          }),
        },
        (bytes) => {
          parts.push(bytes);
        },
      );
      const kek = await deriveRecoveryKitKek(
        { secret: encodeUtf8(input.code), source: 'prompt' },
        hexToBytes(input.salt),
        kdfOf(input),
      );
      return [
        { field: 'kit', actual: parts.map(bytesToHex).join('') },
        { field: 'kek', actual: bytesToHex(kek) },
      ];
    }
    case 'open':
      return evaluateOpen((options) =>
        openRecoveryKit(
          hexToBytes(input.kit),
          { secret: encodeUtf8(input.code), source: input.source },
          input.expectedOwnerNostr === ''
            ? options
            : { ...options, expectedOwnerNostr: hexToBytes(input.expectedOwnerNostr) },
        ),
      );
    case 'openWithKek':
      return evaluateOpen((options) =>
        openRecoveryKitWithKek(hexToBytes(input.kit), hexToBytes(input.kek), options),
      );
    case 'header': {
      const header = readRecoveryKitHeader(hexToBytes(input.kit));
      return [
        { field: 'ownerNostr', actual: bytesToHex(header.ownerNostr) },
        { field: 'chunkSize', actual: String(header.chunkSize) },
        { field: 'memoryKiB', actual: String(header.kdf.memoryKiB) },
        { field: 'iterations', actual: String(header.kdf.iterations) },
        { field: 'parallelism', actual: String(header.kdf.parallelism) },
      ];
    }
    case 'crossType': {
      const blob = hexToBytes(input.blob);
      const code = { secret: encodeUtf8(input.code), source: 'prompt' as const };
      switch (input.reader) {
        case 'ALKP':
          await openPasskeySeed(blob, hexToBytes(input.key));
          break;
        case 'ALKR':
          await openRecoverySeed(blob, code);
          break;
        case 'ALKO':
          await openOwnerSeed(
            blob,
            code,
            {
              ownerEvm: decodeHex0x(input.ownerEvm, { length: 20 }),
              ownerNostr: decodeHex0x(input.ownerNostr, { length: 32 }),
            },
            { fileKeystoreMachine: true },
          );
          break;
        case 'ALKS':
          await openKeystoreFile(blob, code, input.agentId);
          break;
        case 'ALF1':
          await openAlf1(hexToBytes(input.key), blob);
          break;
      }
      return [{ field: 'outcome', actual: 'accept' }];
    }
  }
}

export const recoveryKit: SuiteModule = {
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
