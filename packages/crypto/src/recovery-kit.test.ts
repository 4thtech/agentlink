// M1-9i-b: the recovery kit `ALKK` v1 (04 §2.3.3, D-115). The byte-exact cases are the
// `recovery-kit` vectors (test-vectors/recovery-kit, an independent Python generator); these tests
// pin the API rules around them: a fresh code, salt and nonce prefix per kit; refusals before the
// KDF; streaming input in any piece size; nothing returned and every store sink discarded on any
// failure, including a kit whose last chunk is cut (no file, no state); one generic error for a
// wrong code and a tampered kit; the 4 GiB cap; sealer input checks before anything is written;
// caller errors passed through; and no secret in any error (I-7). The KDF runs at the floor
// (m = 19 MiB, t = 2, p = 1) to keep the suite fast.
import { describe, expect, it, vi } from 'vitest';
import {
  CryptoInputError,
  KEY_LABELS,
  RECOVERY_KIT_HEADER_LENGTH,
  decodeUtf8,
  encodeHex,
  encodeUtf8,
  readRecoveryKitHeader,
  sha256,
} from './index.js';
import {
  deriveAgentId,
  derivePublicKey,
  openRecoveryKit,
  openRecoverySeed,
  sealRecoveryKit,
  type OpenedRecoveryKit,
  type RecoveryKitInput,
  type RecoveryKitStoreSink,
} from './keystore.js';
import { deriveRecoveryKitKek, openRecoveryKitWithKek, sealRecoveryKitWith } from './testing.js';
import { concatBytes } from './bytes.js';

vi.setConfig({ testTimeout: 60_000 });

const FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const bytesOf = (label: string, length = 32): Uint8Array => {
  const out = new Uint8Array(length);
  for (let at = 0, i = 0; at < length; i += 1) {
    const block = sha256(encodeUtf8(`recovery-kit.test/${label}/${i}`));
    out.set(block.subarray(0, Math.min(32, length - at)), at);
    at += 32;
  }
  return out;
};
const OWNER_SEED = bytesOf('owner');
const OWNER = (() => {
  const key = derivePublicKey(OWNER_SEED, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unreachable');
  return key.publicKey;
})();
const CODE = encodeUtf8('ABCDEFGHIJKLMNOPQRSTUVWX');
const SALT = bytesOf('salt', 16);
const PREFIX = bytesOf('prefix', 8);
const KIT_ID = 'AAECAwQFBgcICQoLDA0ODw';

function agent(label: string, name: string, storeLength = 300) {
  const seed = bytesOf(`${label}/seed`);
  const store = bytesOf(`${label}/store`, storeLength);
  return {
    agentId: deriveAgentId(seed),
    name,
    items: [
      { name: 'store-key' as const, value: bytesOf(`${label}/store-key`) },
      { name: 'seed' as const, value: seed },
      { name: 'policy-version' as const, value: encodeUtf8('3') },
    ],
    store: { length: store.length, chunks: [store.subarray(0, 100), store.subarray(100)] },
    storeBytes: store,
  };
}

const A = agent('a', 'default');
const B = agent('b', 'research', 70);
const INPUT: RecoveryKitInput = {
  ownerSeed: OWNER_SEED,
  kitId: KIT_ID,
  createdAt: 1_792_540_800,
  contents: 'full',
  agents: [A, B],
};

async function seal(input: RecoveryKitInput = INPUT, chunkSize = 64): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  await sealRecoveryKitWith(CODE, SALT, PREFIX, chunkSize, FLOOR, input, (b) => {
    parts.push(b);
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Store sinks that record what happens to them. */
function sinks() {
  const made: { parts: Uint8Array[]; discarded: boolean; committed: boolean }[] = [];
  return {
    made,
    createStoreSink(): RecoveryKitStoreSink {
      const record = { parts: [] as Uint8Array[], discarded: false, committed: false };
      made.push(record);
      return {
        write(bytes) {
          record.parts.push(bytes);
        },
        commit() {
          record.committed = true;
        },
        discard() {
          record.discarded = true;
          record.parts.length = 0;
        },
      };
    },
  };
}

const prompt = (code: Uint8Array) => ({ secret: code, source: 'prompt' as const });

async function* pieces(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.slice(at, at + size);
}

async function refusal(promise: Promise<unknown>): Promise<CryptoInputError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CryptoInputError);
  return error as CryptoInputError;
}

const KIT = await seal();
const KEK = await deriveRecoveryKitKek(prompt(CODE), SALT, FLOOR);

describe('ALKK v1 round trip', () => {
  it('opens to the owner seed, the agents sorted by agentId and their items in kit order', async () => {
    const s = sinks();
    const kit = await openRecoveryKit(KIT, prompt(CODE), {
      expectedOwnerNostr: OWNER,
      createStoreSink: () => s.createStoreSink(),
    });
    expect(kit.ownerSeed).toEqual(OWNER_SEED);
    expect(kit.ownerNostr).toEqual(OWNER);
    expect(kit.contents).toBe('full');
    expect(kit.createdAt).toBe(1_792_540_800);
    expect(kit.kitId).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
    const sorted = [A, B].sort((x, y) => (x.agentId < y.agentId ? -1 : 1));
    expect(kit.agents.map((a) => a.agentId)).toEqual(sorted.map((a) => a.agentId));
    for (const [i, opened] of kit.agents.entries()) {
      const want = sorted[i] as typeof A;
      expect(decodeUtf8(opened.name)).toBe(want.name);
      expect(opened.items.map((it) => it.name)).toEqual(['seed', 'store-key', 'policy-version']);
      expect(opened.storeLength).toBe(want.storeBytes.length);
      const record = s.made[i];
      expect(concatBytes(...(record?.parts ?? []))).toEqual(want.storeBytes);
    }
    expect(s.made.every((m) => !m.discarded && m.committed)).toBe(true);
    const seed = kit.ownerSeed;
    const item = kit.agents[0]?.items[0]?.value as Uint8Array;
    kit.wipe();
    expect(seed.every((b) => b === 0)).toBe(true);
    expect(item.every((b) => b === 0)).toBe(true);
  });

  it('reads the kit from a stream in any piece size, the header split included', async () => {
    for (const size of [1, 7, 73, 74, 75, 1000]) {
      const s = sinks();
      const kit = await openRecoveryKitWithKek(pieces(KIT, size), KEK, {
        createStoreSink: () => s.createStoreSink(),
      });
      expect(kit.ownerSeed).toEqual(OWNER_SEED);
    }
  });

  it('accepts a kit with no agents and one with an identity manifest', async () => {
    const none = await seal({ ...INPUT, agents: [], contents: 'identity' });
    const kit = await openRecoveryKitWithKek(none, KEK, {
      createStoreSink: () => sinks().createStoreSink(),
    });
    expect(kit.agents).toEqual([]);
    expect(kit.contents).toBe('identity');
  });

  it('draws a fresh code, salt and nonce prefix for every kit and returns the code grouped', async () => {
    const kits: Uint8Array[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const parts: Uint8Array[] = [];
      const code = await sealRecoveryKit(
        INPUT,
        (b) => {
          parts.push(b);
        },
        FLOOR,
      );
      codes.push(decodeUtf8(code));
      kits.push(concatBytes(...parts));
    }
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
    expect(codes[0]).not.toBe(codes[1]);
    const [k0, k1] = kits as [Uint8Array, Uint8Array];
    expect(k0.subarray(13, 29)).not.toEqual(k1.subarray(13, 29));
    expect(k0.subarray(34, 42)).not.toEqual(k1.subarray(34, 42));
    expect(new DataView(k0.buffer, k0.byteOffset).getUint32(30)).toBe(1_048_576);
    const kit = await openRecoveryKit(k0, prompt(encodeUtf8(codes[0] as string)), {
      createStoreSink: () => sinks().createStoreSink(),
    });
    expect(kit.ownerSeed).toEqual(OWNER_SEED);
  });

  it('reads the public header before the code is asked for', () => {
    const header = readRecoveryKitHeader(KIT.subarray(0, RECOVERY_KIT_HEADER_LENGTH));
    expect(header.ownerNostr).toEqual(OWNER);
    expect(header.chunkSize).toBe(64);
    expect(header.kdf).toEqual(FLOOR);
  });
});

describe('ALKK v1 refusals', () => {
  it('fails a cut last chunk with no result and every store sink discarded (no file, no state)', async () => {
    const s = sinks();
    const error = await refusal(
      openRecoveryKitWithKek(KIT.subarray(0, KIT.length - 20), KEK, {
        createStoreSink: () => s.createStoreSink(),
      }),
    );
    expect(error.code).toBe('open_failed');
    // The stores were streamed while the kit decrypted, and all were discarded at the failure.
    expect(s.made.length).toBeGreaterThan(0);
    expect(s.made.every((m) => m.discarded && m.parts.length === 0 && !m.committed)).toBe(true);
  });

  it('commits no store when the kit fails, and discards them all', async () => {
    const parts: Uint8Array[] = [];
    await sealRecoveryKitWith(CODE, SALT, PREFIX, 64, FLOOR, INPUT, (b) => {
      parts.push(b);
    });
    const s = sinks();
    const kit = concatBytes(...parts);
    const other = kit.slice();
    other.set(new Uint8Array(32).fill(9), 42); // another header owner: the chunks do not authenticate
    await refusal(
      openRecoveryKitWithKek(other, KEK, { createStoreSink: () => s.createStoreSink() }),
    );
    expect(s.made.every((m) => !m.committed)).toBe(true);
  });

  it('passes a failing commit through and discards every store', async () => {
    const failure = new Error('rename failed');
    const s = sinks();
    let calls = 0;
    const error = await openRecoveryKitWithKek(KIT, KEK, {
      createStoreSink: () => {
        calls += 1;
        const sink = s.createStoreSink();
        if (calls === 2) return { ...sink, commit: () => Promise.reject(failure) };
        return sink;
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(failure);
    expect(s.made.every((m) => m.discarded)).toBe(true);
  });

  it('wipes the kek copy when the header is refused before the key is used', async () => {
    const copies: Uint8Array[] = [];
    class Tracked extends Uint8Array<ArrayBuffer> {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
        const copy = Uint8Array.prototype.slice.call(this, start, end) as Uint8Array<ArrayBuffer>;
        copies.push(copy);
        return copy;
      }
    }
    const kek = new Tracked(new ArrayBuffer(KEK.length));
    kek.set(KEK);
    const bad = KIT.slice();
    bad[4] = 2;
    await refusal(
      openRecoveryKitWithKek(bad, kek, { createStoreSink: () => sinks().createStoreSink() }),
    );
    expect(copies.length).toBe(1);
    expect(copies[0]?.every((b) => b === 0)).toBe(true);
    expect(Array.from(kek)).toEqual(Array.from(KEK));
  });

  it('gives one error for a wrong code, a tampered kit, a missing final chunk and a reorder', async () => {
    const step = 64 + 16;
    const body = KIT.subarray(RECOVERY_KIT_HEADER_LENGTH);
    const reordered = concatBytes(
      KIT.subarray(0, RECOVERY_KIT_HEADER_LENGTH),
      body.subarray(step, 2 * step),
      body.subarray(0, step),
      body.subarray(2 * step),
    );
    const tampered = KIT.slice();
    tampered.set(
      [(tampered[RECOVERY_KIT_HEADER_LENGTH + 5] as number) ^ 1],
      RECOVERY_KIT_HEADER_LENGTH + 5,
    );
    const errors = [
      await refusal(
        openRecoveryKit(KIT, prompt(encodeUtf8('ABCDEFGHIJKLMNOPQRSTUVWY')), {
          createStoreSink: () => sinks().createStoreSink(),
        }),
      ),
      await refusal(
        openRecoveryKitWithKek(tampered, KEK, { createStoreSink: () => sinks().createStoreSink() }),
      ),
      await refusal(
        openRecoveryKitWithKek(
          KIT.subarray(0, KIT.length - ((KIT.length - RECOVERY_KIT_HEADER_LENGTH) % step)),
          KEK,
          { createStoreSink: () => sinks().createStoreSink() },
        ),
      ),
      await refusal(
        openRecoveryKitWithKek(reordered, KEK, {
          createStoreSink: () => sinks().createStoreSink(),
        }),
      ),
    ];
    for (const e of errors) {
      expect(e.code).toBe('open_failed');
      expect(e.message).toBe(errors[0]?.message);
    }
  });

  it('refuses before the KDF: header values, KDF bounds and another expected owner', async () => {
    const other = new Uint8Array(32).fill(7);
    const s = sinks();
    expect(
      (
        await refusal(
          openRecoveryKit(KIT, prompt(CODE), {
            expectedOwnerNostr: other,
            createStoreSink: () => s.createStoreSink(),
          }),
        )
      ).code,
    ).toBe('open_failed');
    for (const [offset, value] of [
      [0, 0x42],
      [3, 0x52],
      [4, 2],
      [5, 2],
      [6, 2],
      [11, 1],
      [12, 0],
      [29, 1],
      [33, 0],
    ] as const) {
      const bad = KIT.slice();
      bad[offset] = value;
      if (offset === 33) bad.fill(0, 30, 34);
      expect(
        (
          await refusal(
            openRecoveryKit(bad, prompt(CODE), { createStoreSink: () => s.createStoreSink() }),
          )
        ).code,
      ).toBe('open_failed');
      expect(() => readRecoveryKitHeader(bad)).toThrow(CryptoInputError);
    }
    expect(s.made).toEqual([]);
  });

  it('refuses a malformed code with invalid_secret before the KDF', async () => {
    const error = await refusal(
      openRecoveryKit(KIT, prompt(encodeUtf8('ABC!')), {
        createStoreSink: () => sinks().createStoreSink(),
      }),
    );
    expect(error.code).toBe('invalid_secret');
  });

  it('refuses a kit above the 4 GiB cap (checked with a lower limit)', async () => {
    const error = await refusal(
      openRecoveryKitWithKek(
        KIT,
        KEK,
        { createStoreSink: () => sinks().createStoreSink() },
        { maxKitBytes: KIT.length - 1 },
      ),
    );
    expect(error.code).toBe('open_failed');
    await expect(
      openRecoveryKitWithKek(
        KIT,
        KEK,
        { createStoreSink: () => sinks().createStoreSink() },
        { maxKitBytes: KIT.length },
      ),
    ).resolves.toBeDefined();
  });

  it('cross-type: the ALKR reader refuses a kit, and the kit reader refuses an ALKR blob', async () => {
    await refusal(openRecoverySeed(KIT, prompt(CODE)));
    const alkr = KIT.slice(0, 90);
    alkr.set(encodeUtf8('ALKR'), 0);
    await refusal(
      openRecoveryKit(alkr, prompt(CODE), { createStoreSink: () => sinks().createStoreSink() }),
    );
  });

  it('passes a failing store sink through after discarding the others', async () => {
    const failure = new Error('disk full');
    const s = sinks();
    let calls = 0;
    const error = await openRecoveryKitWithKek(KIT, KEK, {
      createStoreSink: () => {
        calls += 1;
        if (calls === 2)
          return {
            write: () => Promise.reject(failure),
            commit: () => undefined,
            discard: () => undefined,
          };
        return s.createStoreSink();
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(failure);
    expect(s.made.every((m) => m.discarded)).toBe(true);
  });

  it('never puts a secret in an error message (I-7)', async () => {
    const error = await refusal(
      openRecoveryKit(KIT, prompt(encodeUtf8('ABCDEFGHIJKLMNOPQRSTUVWY')), {
        createStoreSink: () => sinks().createStoreSink(),
      }),
    );
    const hex = encodeHex(OWNER_SEED);
    expect(error.message).not.toContain(hex);
    expect(error.message).not.toContain('ABCDEFGH');
  });
});

describe('ALKK v1 sealing checks its input before writing anything', () => {
  const cases: [string, RecoveryKitInput][] = [
    [
      'a seed that does not derive the agentId',
      { ...INPUT, agents: [{ ...A, agentId: B.agentId }] },
    ],
    [
      'an unknown item',
      {
        ...INPUT,
        agents: [
          {
            ...A,
            items: [
              ...A.items,
              { name: 's3:0123456789abcdef' as 'seed', value: new Uint8Array(1) },
            ],
          },
        ],
      },
    ],
    [
      'a missing store-key',
      { ...INPUT, agents: [{ ...A, items: A.items.filter((i) => i.name !== 'store-key') }] },
    ],
    [
      'an item twice',
      { ...INPUT, agents: [{ ...A, items: [...A.items, A.items[0] as (typeof A.items)[number]] }] },
    ],
    [
      'an item above 64 KiB',
      {
        ...INPUT,
        agents: [
          { ...A, items: [...A.items, { name: 'storage-mark', value: new Uint8Array(65_537) }] },
        ],
      },
    ],
    ['the same agent twice', { ...INPUT, agents: [A, A] }],
    ['two agents with the same name', { ...INPUT, agents: [A, { ...B, name: A.name }] }],
    [
      '17 agents',
      { ...INPUT, agents: Array.from({ length: 17 }, (_, i) => agent(`many/${i}`, `a${i}`, 1)) },
    ],
    ['an upper-case agent name', { ...INPUT, agents: [{ ...A, name: 'Default' }] }],
    [
      'a checksummed agentId',
      { ...INPUT, agents: [{ ...A, agentId: A.agentId.toUpperCase().replace('0X', '0x') }] },
    ],
    ['a kitId of 15 bytes', { ...INPUT, kitId: 'AAECAwQFBgcICQoLDA0O' }],
    ['a negative createdAt', { ...INPUT, createdAt: -1 }],
    ['other contents', { ...INPUT, contents: 'all' as 'full' }],
    ['a 31-byte owner seed', { ...INPUT, ownerSeed: OWNER_SEED.subarray(0, 31) }],
    [
      'a store above 1 GiB',
      { ...INPUT, agents: [{ ...A, store: { length: 2 ** 30 + 1, chunks: [] } }] },
    ],
  ];
  for (const [why, input] of cases) {
    it(`refuses ${why}`, async () => {
      const written: Uint8Array[] = [];
      await refusal(
        sealRecoveryKitWith(CODE, SALT, PREFIX, 64, FLOOR, input, (b) => {
          written.push(b);
        }),
      );
      expect(written).toEqual([]);
    });
  }

  it('refuses a store whose bytes do not match its length', async () => {
    const short = { ...A, store: { length: 10, chunks: [new Uint8Array(9)] } };
    const long = { ...A, store: { length: 10, chunks: [new Uint8Array(11)] } };
    for (const a of [short, long]) {
      await refusal(
        sealRecoveryKitWith(
          CODE,
          SALT,
          PREFIX,
          64,
          FLOOR,
          { ...INPUT, agents: [a] },
          () => undefined,
        ),
      );
    }
  });

  it('refuses KDF parameters outside the floor and cap and a chunk size outside 1 B..16 MiB', async () => {
    await refusal(
      sealRecoveryKitWith(
        CODE,
        SALT,
        PREFIX,
        64,
        { ...FLOOR, iterations: 1 },
        INPUT,
        () => undefined,
      ),
    );
    await refusal(sealRecoveryKitWith(CODE, SALT, PREFIX, 0, FLOOR, INPUT, () => undefined));
    await refusal(
      sealRecoveryKitWith(CODE, SALT, PREFIX, 16 * 2 ** 20 + 1, FLOOR, INPUT, () => undefined),
    );
  });
});

// Type-level: the opened kit's item values are bytes, never strings (04 §2.3.3).
const typeCheck = (kit: OpenedRecoveryKit): Uint8Array =>
  kit.agents[0]?.items[0]?.value ?? kit.ownerSeed;
void typeCheck;
