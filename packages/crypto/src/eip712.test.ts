// M1-1e: EIP-712 typed-data hashing. Checked against the EIP's own example (Example.js, "Ether
// Mail") and, differentially, against viem's hashTypedData on generated typed data (viem is a
// devDependency used only as an oracle here).
import {
  hashDomain as viemHashDomain,
  hashStruct as viemHashStruct,
  hashTypedData as viemHashTypedData,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  eip712EncodeType,
  eip712HashStruct,
  eip712TypeHash,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  hashTypedData,
  keccak256,
  type TypedData,
  type TypedDataTypes,
} from './index.js';
import { signTypedData } from './keystore.js';

// EIP-712 Example.js (ethereum/EIPs@e1e9c0c0), the same values tools/vectors/generate_eip712.py
// checks before it writes the suite.
const MAIL = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
} as const satisfies TypedData;

const PUBLISHED = {
  encodeType: 'Mail(Person from,Person to,string contents)Person(string name,address wallet)',
  typeHash: 'a0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2',
  structHash: 'c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e',
  domainSeparator: 'f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f',
  digest: 'be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
  signature:
    '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d' +
    '07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562' +
    '1c',
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mail = (): {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
} => clone(MAIL) as never;

const expectInputError = (run: () => unknown): CryptoInputError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe('invalid_typed_data');
    return error as CryptoInputError;
  }
  throw new Error('expected a CryptoInputError');
};

describe('EIP-712 example (Ether Mail)', () => {
  it('encodes the type and hashes it as published', () => {
    expect(eip712EncodeType(MAIL.types, 'Mail')).toBe(PUBLISHED.encodeType);
    expect(encodeHex(eip712TypeHash(MAIL.types, 'Mail'))).toBe(PUBLISHED.typeHash);
  });

  it('hashes the struct, the domain and the digest as published', () => {
    expect(encodeHex(eip712HashStruct(MAIL.types, 'Mail', MAIL.message))).toBe(
      PUBLISHED.structHash,
    );
    const hashes = hashTypedData(MAIL);
    expect(encodeHex(hashes.domainSeparator)).toBe(PUBLISHED.domainSeparator);
    expect(encodeHex(hashes.structHash)).toBe(PUBLISHED.structHash);
    expect(encodeHex(hashes.digest)).toBe(PUBLISHED.digest);
  });

  it('signs as published with keccak256("cow")', () => {
    expect(signTypedData(MAIL, keccak256(encodeUtf8('cow')))).toBe(PUBLISHED.signature);
  });
});

// --- differential against viem ------------------------------------------------------------------

/** A small deterministic generator, so a failure reproduces. */
function prng(seed: string): (n: number) => Uint8Array {
  let counter = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 32) {
      const block = keccak256(encodeUtf8(`${seed}/${counter}`));
      counter += 1;
      out.set(block.subarray(0, Math.min(32, n - i)), i);
    }
    return out;
  };
}

const ATOMS = [
  'uint8',
  'uint32',
  'uint64',
  'uint256',
  'address',
  'bytes32',
  'bytes1',
  'bytes20',
  'bool',
  'string',
  'bytes',
];

function valueFor(type: string, random: (n: number) => Uint8Array): unknown {
  const r = random(40);
  if (type === 'bool') return (r[0] as number) % 2 === 0;
  if (type === 'address') return encodeHex0x(r.subarray(0, 20));
  if (type === 'string') return `s-${encodeHex(r.subarray(0, (r[0] as number) % 12))}-ü😀`;
  if (type === 'bytes') return encodeHex0x(r.subarray(0, 1 + ((r[0] as number) % 39)));
  const bytesN = /^bytes([0-9]+)$/.exec(type);
  if (bytesN) return encodeHex0x(r.subarray(0, Number(bytesN[1])));
  const bits = Number(/^uint([0-9]+)$/.exec(type)?.[1]);
  const big = BigInt('0x' + encodeHex(r.subarray(0, 32))) & ((1n << BigInt(bits)) - 1n);
  return bits <= 32 ? Number(big) : big;
}

function generate(seed: string): TypedData {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[(random(1)[0] as number) % list.length] as T;
  const inner = Array.from({ length: 1 + ((random(1)[0] as number) % 4) }, (_, i) => ({
    name: `i${i}`,
    type: pick(ATOMS),
  }));
  const outer = Array.from({ length: 2 + ((random(1)[0] as number) % 5) }, (_, i) => ({
    name: `f${i}`,
    type: i === 1 ? 'Inner' : pick(ATOMS),
  }));
  const types = {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Inner: inner,
    Outer: outer,
  };
  const struct = (fields: Array<{ name: string; type: string }>): Record<string, unknown> =>
    Object.fromEntries(
      fields.map((f) => [f.name, f.type === 'Inner' ? struct(inner) : valueFor(f.type, random)]),
    );
  return {
    types,
    primaryType: 'Outer',
    domain: {
      name: `d-${seed}`,
      version: '2',
      chainId: BigInt(1 + ((random(1)[0] as number) % 200)),
      verifyingContract: encodeHex0x(random(20)),
    },
    message: struct(outer),
  };
}

describe('differential: hashTypedData against viem', () => {
  it('matches viem on 200 generated typed-data objects', () => {
    for (let i = 0; i < 200; i += 1) {
      const td = generate(`case-${i}`);
      const ours = hashTypedData(td);
      const theirs = td as unknown as TypedDataDefinition;
      expect(encodeHex0x(ours.digest), `case-${i}`).toBe(viemHashTypedData(theirs));
      expect(encodeHex0x(ours.domainSeparator)).toBe(
        viemHashDomain({ domain: td.domain, types: td.types } as never),
      );
      expect(encodeHex0x(ours.structHash)).toBe(
        viemHashStruct({ data: td.message, primaryType: 'Outer', types: td.types } as never),
      );
    }
  });

  it('signs like viem on generated typed data', async () => {
    const key = keccak256(encodeUtf8('m11e/test/typed-data-signer'));
    const account = privateKeyToAccount(encodeHex0x(key) as `0x${string}`);
    for (let i = 0; i < 10; i += 1) {
      const td = generate(`sign-${i}`);
      expect(signTypedData(td, key)).toBe(
        await account.signTypedData(td as unknown as TypedDataDefinition),
      );
    }
  });

  it('accepts a domain with only some of the standard fields, in order', () => {
    const td = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
        ],
        Thing: [{ name: 'x', type: 'uint64' }],
      },
      primaryType: 'Thing',
      domain: { name: 'OCC AgentCard', version: '1' },
      message: { x: 5n },
    } satisfies TypedData;
    expect(encodeHex0x(hashTypedData(td).digest)).toBe(
      viemHashTypedData(td as unknown as TypedDataDefinition),
    );
  });
});

// --- refusals -------------------------------------------------------------------------------------

describe('hashTypedData refuses malformed typed data', () => {
  const cases: Array<[string, (td: ReturnType<typeof mail>) => void]> = [
    ['no EIP712Domain type', (td) => delete td.types.EIP712Domain],
    ['domain fields out of the standard order', (td) => td.types.EIP712Domain?.reverse()],
    [
      'a non-standard domain field',
      (td) => {
        td.types.EIP712Domain?.push({ name: 'extra', type: 'string' });
        td.domain.extra = 'x';
      },
    ],
    [
      'a standard domain field with the wrong type',
      (td) => {
        (td.types.EIP712Domain as Array<{ name: string; type: string }>)[2] = {
          name: 'chainId',
          type: 'uint64',
        };
      },
    ],
    ['a domain value missing', (td) => delete td.domain.chainId],
    ['an extra domain value', (td) => (td.domain.salt = '0x' + '00'.repeat(32))],
    ['an unknown primary type', (td) => (td.primaryType = 'Letter')],
    ['EIP712Domain as primary type', (td) => (td.primaryType = 'EIP712Domain')],
    ['an undefined field type', (td) => (td.types.Person![0]!.type = 'Name')],
    ['an array type', (td) => (td.types.Person![0]!.type = 'string[]')],
    ['a signed integer type', (td) => (td.types.Person![0]!.type = 'int256')],
    ['uint without a size', (td) => (td.types.Person![0]!.type = 'uint')],
    ['uint7', (td) => (td.types.Person![0]!.type = 'uint7')],
    ['bytes33', (td) => (td.types.Person![0]!.type = 'bytes33')],
    ['bytes0', (td) => (td.types.Person![0]!.type = 'bytes0')],
    ['a duplicate field name', (td) => td.types.Person!.push({ name: 'name', type: 'string' })],
    ['a field with an extra key', (td) => Object.assign(td.types.Person![0]!, { extra: 1 })],
    ['a type name that is not an identifier', (td) => (td.types['Bad Name'] = [])],
    ['a struct named like an atomic type', (td) => (td.types.address = [])],
    ['a message field missing', (td) => delete td.message.contents],
    ['an extra message field', (td) => (td.message.cc = 'x')],
    ['a nested field missing', (td) => delete (td.message.from as Record<string, unknown>).wallet],
    ['a struct value that is not an object', (td) => (td.message.from = 'Cow')],
    ['an array as a struct value', (td) => (td.message.from = ['Cow'])],
    [
      'an address with a wrong EIP-55 checksum',
      (td) =>
        ((td.message.to as Record<string, unknown>).wallet =
          '0xBbBbBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'),
    ],
    [
      'an address of 19 bytes',
      (td) => ((td.message.to as Record<string, unknown>).wallet = '0x' + 'bb'.repeat(19)),
    ],
    [
      'an address without 0x',
      (td) => ((td.message.to as Record<string, unknown>).wallet = 'bb'.repeat(20)),
    ],
    ['chainId as a decimal string', (td) => (td.domain.chainId = '1')],
    ['chainId negative', (td) => (td.domain.chainId = -1)],
    ['chainId 1.5', (td) => (td.domain.chainId = 1.5)],
    ['chainId above 2^53 - 1 as a number', (td) => (td.domain.chainId = 2 ** 53)],
    ['chainId -0', (td) => (td.domain.chainId = -0)],
    ['chainId 2^256', (td) => (td.domain.chainId = 1n << 256n)],
    ['a string with a lone surrogate', (td) => (td.message.contents = 'a\ud800b')],
    ['a string field given as bytes', (td) => (td.message.contents = new Uint8Array(1))],
  ];
  it.each(cases)('%s', (_, mutate) => {
    const td = mail();
    mutate(td);
    expectInputError(() => hashTypedData(td as TypedData));
  });

  it('refuses a uint8 above 255 and a bytes32 of the wrong length', () => {
    const types: TypedDataTypes = {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      T: [
        { name: 'a', type: 'uint8' },
        { name: 'b', type: 'bytes32' },
        { name: 'c', type: 'bool' },
      ],
    };
    const ok = { a: 255, b: '0x' + '11'.repeat(32), c: true };
    expect(() =>
      hashTypedData({ types, primaryType: 'T', domain: { name: 'n' }, message: ok }),
    ).not.toThrow();
    for (const message of [
      { ...ok, a: 256 },
      { ...ok, a: 256n },
      { ...ok, b: '0x' + '11'.repeat(31) },
      { ...ok, b: '0x' + '11'.repeat(33) },
      { ...ok, b: '0x' + 'AA'.repeat(32) },
      { ...ok, c: 1 },
      { ...ok, c: 'true' },
    ]) {
      expectInputError(() =>
        hashTypedData({ types, primaryType: 'T', domain: { name: 'n' }, message }),
      );
    }
  });

  it('refuses an accessor property instead of reading it', () => {
    const td = mail();
    let reads = 0;
    Object.defineProperty(td.message, 'contents', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'Hello, Bob!';
      },
    });
    expectInputError(() => hashTypedData(td as TypedData));
    expect(reads).toBe(0);
  });

  it('refuses a recursive type without overflowing the stack', () => {
    const types: TypedDataTypes = {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Node: [
        { name: 'v', type: 'uint8' },
        { name: 'next', type: 'Node' },
      ],
    };
    let message: Record<string, unknown> = { v: 0, next: {} };
    for (let i = 0; i < 100_000; i += 1) message = { v: 1, next: message };
    expectInputError(() =>
      hashTypedData({ types, primaryType: 'Node', domain: { name: 'n' }, message }),
    );
  });

  it('names no input value in its errors', () => {
    const td = mail();
    (td.message.to as Record<string, unknown>).wallet = '0x' + 'ab'.repeat(21);
    const error = expectInputError(() => hashTypedData(td as TypedData));
    expect(error.message).not.toContain('abab');
  });

  it('signTypedData refuses a bad key without echoing it', () => {
    const zero = new Uint8Array(32);
    try {
      signTypedData(MAIL, zero);
      throw new Error('expected a CryptoInputError');
    } catch (error) {
      expect((error as CryptoInputError).code).toBe('invalid_argument');
    }
  });
});
