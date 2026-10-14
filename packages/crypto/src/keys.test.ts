// M1-1b: key derivation (04 §2.1), the agent ID (§2.9), the X25519 `kid` (§3.1) and the public
// identity bundle, which never carries the drop key (§2.1, §4, D-48). The cross-runtime vectors in
// test-vectors/hkdf-derive check the bytes against an independent generator; these tests pin the
// API rules around them.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  KEY_LABELS,
  concatBytes,
  decodeHex,
  decodeHex0x,
  deriveAgentId,
  deriveKey,
  derivePublicIdentity,
  derivePublicKey,
  deriveSecretKey,
  encodeHex,
  encodeUtf8,
  evmAddressChecksummed,
  hkdfSha256,
  kidFromEncPublicKey,
  sha256,
} from './index.js';
import { selectSecp256k1SecretKey } from './keys.js';

const SEED_A = decodeHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = decodeHex('e41941bf51f3a630b7645066dfb5e8cbeb7caa9683cb438566f608dc1feb2c88');
const N = decodeHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

const copy = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);

function expectRefused(run: () => unknown): CryptoInputError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoInputError);
  return caught as CryptoInputError;
}

describe('KEY_LABELS', () => {
  it('holds exactly the four labels of 04 §2.1 and cannot be changed at run time', () => {
    expect(KEY_LABELS).toEqual({
      evm: 'agentlink/v1/evm',
      nostr: 'agentlink/v1/nostr',
      enc: 'agentlink/v1/enc',
      drop: 'agentlink/v1/drop',
    });
    expect(Object.isFrozen(KEY_LABELS)).toBe(true);
  });
});

describe('hkdfSha256', () => {
  it('computes RFC 5869 test case 1', () => {
    const okm = hkdfSha256(
      decodeHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
      decodeHex('000102030405060708090a0b0c'),
      decodeHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(encodeHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('refuses a length outside 1..8160 and inputs that are not bytes', () => {
    const k = new Uint8Array(32);
    for (const length of [0, -1, 8161, 1.5, Number.NaN]) {
      expect(expectRefused(() => hkdfSha256(k, k, k, length)).code).toBe('invalid_argument');
    }
    expect(hkdfSha256(k, k, k, 8160)).toHaveLength(8160);
    expectRefused(() => hkdfSha256('00' as unknown as Uint8Array, k, k, 32));
    expectRefused(() => hkdfSha256(k, [0] as unknown as Uint8Array, k, 32));
    expectRefused(() => hkdfSha256(k, k, null as unknown as Uint8Array, 32));
  });
});

describe('deriveKey (04 §2.1)', () => {
  it('uses salt "agentlink-v1" and info = label || 0x00 || u32be(epoch) || u8(counter), L = 32', () => {
    const info = concatBytes(
      encodeUtf8('agentlink/v1/nostr'),
      Uint8Array.of(0x00, 0x01, 0x02, 0x03, 0x04, 0x05),
    );
    const expected = hkdfSha256(SEED_A, encodeUtf8('agentlink-v1'), info, 32);
    expect(encodeHex(deriveKey(SEED_A, KEY_LABELS.nostr, 0x01020304, 5))).toBe(encodeHex(expected));
  });

  it('gives each label, epoch and counter its own key', () => {
    const seen = new Set<string>();
    for (const label of Object.values(KEY_LABELS)) {
      for (const epoch of label === KEY_LABELS.evm ? [0] : [0, 1, 256]) {
        for (const counter of [0, 1, 255]) {
          seen.add(encodeHex(deriveKey(SEED_A, label, epoch, counter)));
        }
      }
    }
    expect(seen.size).toBe(3 + 3 * 3 * 3);
  });

  it('refuses a seed that is not exactly 32 bytes', () => {
    for (const seed of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      expectRefused(() => deriveKey(seed, KEY_LABELS.nostr, 0, 0));
    }
    expectRefused(() =>
      deriveKey(encodeHex(SEED_A) as unknown as Uint8Array, KEY_LABELS.nostr, 0, 0),
    );
  });

  it('refuses an epoch that is not a u32 and a counter that is not a u8', () => {
    for (const epoch of [-1, 2 ** 32, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
      expectRefused(() => deriveKey(SEED_A, KEY_LABELS.nostr, epoch as number, 0));
    }
    for (const counter of [-1, 256, 0.5, Number.NaN, '0']) {
      expectRefused(() => deriveKey(SEED_A, KEY_LABELS.nostr, 0, counter as number));
    }
    expect(deriveKey(SEED_A, KEY_LABELS.nostr, 2 ** 32 - 1, 255)).toHaveLength(32);
  });

  it('refuses any label outside 04 §2.1, including near misses', () => {
    for (const label of [
      'agentlink/v1/unknown',
      'agentlink/v2/nostr',
      'AGENTLINK/v1/nostr',
      'agentlink/v1/nostr ',
      'agentlink/v1/nostr\u0000',
      '',
    ]) {
      expectRefused(() => deriveKey(SEED_A, label as never, 0, 0));
    }
  });

  it('refuses the EVM key at any epoch other than 0 (04 §2.1: always epoch 0)', () => {
    for (const epoch of [1, 2, 2 ** 32 - 1]) {
      expectRefused(() => deriveKey(SEED_A, KEY_LABELS.evm, epoch, 0));
      expectRefused(() => deriveSecretKey(SEED_A, KEY_LABELS.evm, epoch));
      expectRefused(() => derivePublicKey(SEED_A, KEY_LABELS.evm, epoch));
    }
  });

  it('leaves the caller seed untouched', () => {
    const seed = copy(SEED_B);
    deriveKey(seed, KEY_LABELS.enc, 3, 0);
    deriveSecretKey(seed, KEY_LABELS.nostr, 3);
    derivePublicKey(seed, KEY_LABELS.drop, 3);
    derivePublicIdentity(seed, 3);
    deriveAgentId(seed);
    expect(encodeHex(seed)).toBe(encodeHex(SEED_B));
  });
});

describe('secp256k1 rejection loop (04 §2.1)', () => {
  // A seed whose okm is 0 or >= n is infeasible to find (about 2^-128), so the loop is driven with
  // injected okm values.
  const valid = decodeHex('8c30ba481f8dd080a2adcf9d7a618c3b1cecfd544789fe12b16fef3417ed9679');
  const nPlusOne = decodeHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142');

  it('skips okm = 0, okm = n and okm > n, incrementing the counter from 0', () => {
    const rejected = [new Uint8Array(32), copy(N), copy(nPlusOne), new Uint8Array(32).fill(0xff)];
    const counters: number[] = [];
    const key = selectSecp256k1SecretKey((counter) => {
      counters.push(counter);
      return counter < rejected.length ? (rejected[counter] as Uint8Array) : copy(valid);
    });
    expect(counters).toEqual([0, 1, 2, 3, 4]);
    expect(encodeHex(key)).toBe(encodeHex(valid));
    for (const okm of rejected) expect(okm.every((byte) => byte === 0)).toBe(true);
  });

  it('accepts okm = n - 1 and okm = 1 at counter 0', () => {
    const nMinusOne = decodeHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');
    const one = new Uint8Array(32);
    one[31] = 1;
    for (const okm of [nMinusOne, one]) {
      const counters: number[] = [];
      const key = selectSecp256k1SecretKey((counter) => {
        counters.push(counter);
        return copy(okm);
      });
      expect(counters).toEqual([0]);
      expect(encodeHex(key)).toBe(encodeHex(okm));
    }
  });

  it('fails closed after counter 255 instead of wrapping', () => {
    const counters: number[] = [];
    const error = expectRefused(() =>
      selectSecp256k1SecretKey((counter) => {
        counters.push(counter);
        return copy(N);
      }),
    );
    expect(counters).toHaveLength(256);
    expect(counters.at(-1)).toBe(255);
    expect(error.message).not.toContain(encodeHex(N));
  });

  it('is what deriveSecretKey uses for every secp256k1 label', () => {
    for (const label of [KEY_LABELS.evm, KEY_LABELS.nostr, KEY_LABELS.drop]) {
      const epoch = label === KEY_LABELS.evm ? 0 : 2;
      expect(encodeHex(deriveSecretKey(SEED_A, label, epoch))).toBe(
        encodeHex(selectSecp256k1SecretKey((counter) => deriveKey(SEED_A, label, epoch, counter))),
      );
    }
  });
});

describe('deriveSecretKey', () => {
  it('returns the okm itself for the X25519 label (the library clamps, 04 §2.1)', () => {
    expect(encodeHex(deriveSecretKey(SEED_A, KEY_LABELS.enc, 1))).toBe(
      encodeHex(deriveKey(SEED_A, KEY_LABELS.enc, 1, 0)),
    );
  });

  it('returns a fresh buffer each call, so wiping one does not affect the next', () => {
    const first = deriveSecretKey(SEED_A, KEY_LABELS.nostr, 0);
    first.fill(0);
    expect(deriveSecretKey(SEED_A, KEY_LABELS.nostr, 0).some((byte) => byte !== 0)).toBe(true);
  });
});

describe('agent ID (04 §2.9)', () => {
  it('is the epoch-0 EVM address as 0x + 40 lowercase hex', () => {
    expect(deriveAgentId(SEED_A)).toBe('0xe8118b7407afbd4a12c0df832c67ce0e2eb20cd6');
    expect(deriveAgentId(SEED_B)).toBe('0x441e5fe96afae9130411dabd2304e4bcc77e78bc');
    const evm = derivePublicKey(SEED_A, KEY_LABELS.evm, 0);
    expect(evm.label).toBe(KEY_LABELS.evm);
    if (evm.label !== KEY_LABELS.evm) return;
    expect(evm.agentId).toBe(deriveAgentId(SEED_A));
    expect(encodeHex(evm.address)).toBe(encodeHex(decodeHex0x(evm.agentId, { length: 20 })));
  });

  it('does not change when the key epoch rotates (04 §2.6)', () => {
    const e0 = derivePublicIdentity(SEED_A, 0);
    const e5 = derivePublicIdentity(SEED_A, 5);
    expect(e5.agentId).toBe(e0.agentId);
    expect(encodeHex(e5.agentNostr)).not.toBe(encodeHex(e0.agentNostr));
    expect(encodeHex(e5.agentEnc)).not.toBe(encodeHex(e0.agentEnc));
  });
});

describe('evmAddressChecksummed (EIP-55, display only)', () => {
  // The EIP-55 specification's own examples.
  const EIP55 = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('produces the EIP-55 form of a canonical address', () => {
    for (const display of EIP55) expect(evmAddressChecksummed(display.toLowerCase())).toBe(display);
  });

  it('refuses a checksummed, upper-case, unprefixed or wrong-length address as input', () => {
    for (const text of [
      EIP55[0] as string,
      '0x' + 'AB'.repeat(20),
      'ab'.repeat(20),
      '0X' + 'ab'.repeat(20),
      '0x' + 'ab'.repeat(19),
      '0x' + 'ab'.repeat(32),
    ]) {
      expectRefused(() => evmAddressChecksummed(text));
    }
  });
});

describe('kid (04 §3.1)', () => {
  it('is the first 16 bytes of sha256(raw 32-byte encPub)', () => {
    const enc = derivePublicKey(SEED_A, KEY_LABELS.enc, 0);
    expect(enc.label).toBe(KEY_LABELS.enc);
    if (enc.label !== KEY_LABELS.enc) return;
    expect(encodeHex(enc.kid)).toBe(encodeHex(sha256(enc.publicKey).subarray(0, 16)));
    expect(encodeHex(kidFromEncPublicKey(enc.publicKey))).toBe(encodeHex(enc.kid));
  });

  it('refuses a key that is not 32 bytes', () => {
    expectRefused(() => kidFromEncPublicKey(new Uint8Array(31)));
    expectRefused(() => kidFromEncPublicKey(new Uint8Array(33)));
  });
});

describe('public identity (no drop key: 04 §2.1, §4, D-48)', () => {
  function allValues(value: unknown, out: unknown[] = []): unknown[] {
    out.push(value);
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const inner of Object.values(value)) allValues(inner, out);
    }
    return out;
  }

  it('has exactly the agent card key fields', () => {
    const identity = derivePublicIdentity(SEED_A, 2);
    expect(Object.keys(identity).sort()).toEqual(
      ['agentEnc', 'agentEvm', 'agentId', 'agentNostr', 'keyEpoch', 'kid'].sort(),
    );
    expect(identity.keyEpoch).toBe(2);
    expect(identity.agentId).toBe(deriveAgentId(SEED_A));
    expect(encodeHex(identity.agentEvm)).toBe(identity.agentId.slice(2));
    const nostr = derivePublicKey(SEED_A, KEY_LABELS.nostr, 2);
    const enc = derivePublicKey(SEED_A, KEY_LABELS.enc, 2);
    if (nostr.label !== KEY_LABELS.nostr || enc.label !== KEY_LABELS.enc) throw new Error('kind');
    expect(encodeHex(identity.agentNostr)).toBe(encodeHex(nostr.publicKey));
    expect(encodeHex(identity.agentEnc)).toBe(encodeHex(enc.publicKey));
    expect(encodeHex(identity.kid)).toBe(encodeHex(enc.kid));
  });

  it('never contains the drop public key or any drop key material, at any epoch', () => {
    for (const seed of [SEED_A, SEED_B]) {
      for (const epoch of [0, 1, 2]) {
        const identity = derivePublicIdentity(seed, epoch);
        const forbidden: string[] = [];
        for (const dropEpoch of [0, 1, 2]) {
          const drop = derivePublicKey(seed, KEY_LABELS.drop, dropEpoch);
          if (drop.label !== KEY_LABELS.drop) throw new Error('kind');
          forbidden.push(encodeHex(drop.publicKey));
          forbidden.push(encodeHex(deriveSecretKey(seed, KEY_LABELS.drop, dropEpoch)));
        }
        const text = allValues(identity)
          .map((value) => (value instanceof Uint8Array ? encodeHex(value) : String(value)))
          .join('|');
        for (const hex of forbidden) {
          expect(text).not.toContain(hex);
          expect(text).not.toContain(hex.slice(0, 16));
        }
        expect(JSON.stringify(identity)).not.toMatch(/drop/i);
      }
    }
  });

  it('is frozen, so a caller cannot add a field to it', () => {
    const identity = derivePublicIdentity(SEED_A, 0);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('refuses a key epoch that is not a u32', () => {
    for (const epoch of [-1, 2 ** 32, 0.5])
      expectRefused(() => derivePublicIdentity(SEED_A, epoch));
  });
});

describe('I-7: refusals never echo secret input', () => {
  it('keeps the seed, its length and its bytes out of every error', () => {
    const seed = new Uint8Array(31).fill(0xa7);
    const seedHex = encodeHex(seed);
    const errors = [
      expectRefused(() => deriveKey(seed, KEY_LABELS.nostr, 0, 0)),
      expectRefused(() => deriveSecretKey(seed, KEY_LABELS.nostr, 0)),
      expectRefused(() => derivePublicKey(seed, KEY_LABELS.nostr, 0)),
      expectRefused(() => derivePublicIdentity(seed, 0)),
      expectRefused(() => deriveAgentId(seed)),
      expectRefused(() => deriveKey(SEED_A, 'agentlink/v1/x' as never, 0, 0)),
    ];
    for (const error of errors) {
      const text = `${error.message} ${String(error)} ${JSON.stringify(error)} ${String(error.stack)}`;
      expect(text).not.toContain(seedHex.slice(0, 8));
      expect(text).not.toContain(encodeHex(SEED_A).slice(0, 16));
      expect(error.message).not.toContain('31'); // the actual length is not echoed either
      expect(text.toLowerCase()).not.toContain('a7a7');
    }
  });
});
