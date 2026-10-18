// M1-1j (rest): the OCCRegistry `Revocation` typed data (05 §4, D-81) and its JSON form (05 §4,
// proposed; 04 §2.4.1). Checked against the 05 §4 struct text and, differentially, against viem (a
// devDependency used only as an oracle here). The independent vectors are the `eip712-revocation`
// suite in test-vectors/.
import { getAddress, hashTypedData as viemHashTypedData, type TypedDataDefinition } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  REGISTRATION_TYPES,
  REVOCATION_TYPES,
  eip712EncodeType,
  encodeHex,
  hashRegistration,
  hashRevocation,
  parseRevocation,
  revocationTypedData,
} from './index.js';

const hex32 = (byte: string): string => '0x' + byte.repeat(32);
const REGISTRY = '0xc3c7797dd554c8de871aa72b40882764803eb675';
const AGENT = '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a';
const FEE_ASSET = '0x05f7cddba6070777972ad9ff9df5312872a49685';
const DOMAIN = { name: 'OCC', version: '2', chainId: 84532, verifyingContract: REGISTRY };
const NONCE = '78219569170084842465697082356206593203654915056229411319944921062164124938175';
const UINT256_MAX = (1n << 256n) - 1n;

const REVOCATION = { agentEvm: AGENT, keyEpoch: 3, nonce: NONCE, deadline: 1760003600 };

const viemRevocationDigest = (domain: object, message: Record<string, unknown>): string =>
  viemHashTypedData({
    types: { Revocation: REVOCATION_TYPES.Revocation },
    primaryType: 'Revocation',
    domain,
    message,
  } as unknown as TypedDataDefinition).slice(2);

const expectRefused = (run: () => unknown): void => {
  expect(run).toThrow(CryptoInputError);
};

const omit = <T extends object>(value: T, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('Revocation type (05 §4, D-81)', () => {
  it('encodes the struct exactly as 05 §4 declares it, with uint32 keyEpoch', () => {
    expect(eip712EncodeType(REVOCATION_TYPES, 'Revocation')).toBe(
      'Revocation(address agentEvm,uint32 keyEpoch,uint256 nonce,uint64 deadline)',
    );
    expect(REVOCATION_TYPES.EIP712Domain?.map((f) => f.name)).toEqual([
      'name',
      'version',
      'chainId',
      'verifyingContract',
    ]);
  });
});

describe('hashRevocation', () => {
  it('matches viem on the canonical JSON form', () => {
    const big = { ...REVOCATION, nonce: BigInt(NONCE) };
    expect(encodeHex(hashRevocation(DOMAIN, REVOCATION).digest)).toBe(
      viemRevocationDigest(DOMAIN, big),
    );
  });

  it('accepts every field at its maximum', () => {
    const max = {
      agentEvm: '0x' + 'ff'.repeat(20),
      keyEpoch: 2 ** 32 - 1,
      nonce: UINT256_MAX.toString(),
      deadline: Number.MAX_SAFE_INTEGER,
    };
    expect(encodeHex(hashRevocation(DOMAIN, max).digest)).toBe(
      viemRevocationDigest(DOMAIN, { ...max, nonce: UINT256_MAX }),
    );
  });

  it('gives a digest distinct from a Registration with the same nonce and deadline', () => {
    const registration = {
      cardHash: hex32('b6'),
      feeToken: FEE_ASSET,
      maxFee: '1000000',
      appId: hex32('00'),
      nonce: NONCE,
      deadline: REVOCATION.deadline,
    };
    const reg = hashRegistration(DOMAIN, registration);
    const rev = hashRevocation(DOMAIN, REVOCATION);
    expect(reg.domainSeparator).toEqual(rev.domainSeparator);
    expect(reg.typeHash).not.toEqual(rev.typeHash);
    expect(reg.digest).not.toEqual(rev.digest);
    expect(eip712EncodeType(REGISTRATION_TYPES, 'Registration')).not.toContain('Revocation');
  });

  it('binds the epoch, the nonce and the domain', () => {
    const base = hashRevocation(DOMAIN, REVOCATION).digest;
    expect(hashRevocation(DOMAIN, { ...REVOCATION, keyEpoch: 4 }).digest).not.toEqual(base);
    expect(hashRevocation(DOMAIN, { ...REVOCATION, nonce: '1' }).digest).not.toEqual(base);
    expect(hashRevocation({ ...DOMAIN, chainId: 10200 }, REVOCATION).digest).not.toEqual(base);
  });

  it('typed data carries the parsed message with nonce as bigint, frozen', () => {
    const td = revocationTypedData(DOMAIN, REVOCATION);
    expect(td.primaryType).toBe('Revocation');
    expect(td.message.nonce).toBe(BigInt(NONCE));
    expect(td.message.keyEpoch).toBe(3);
    expect(Object.isFrozen(td.message)).toBe(true);
  });

  it('refuses a domain other than the OCC v2 chain domain', () => {
    expectRefused(() => hashRevocation({ ...DOMAIN, name: 'OCC AgentCard' }, REVOCATION));
    expectRefused(() => hashRevocation({ ...DOMAIN, version: '1' }, REVOCATION));
    expectRefused(() =>
      hashRevocation({ ...DOMAIN, verifyingContract: getAddress(REGISTRY) }, REVOCATION),
    );
    expectRefused(() => hashRevocation(omit(DOMAIN, 'chainId'), REVOCATION));
  });
});

describe('parseRevocation (05 §4 JSON form, proposed; 04 §2.4.1)', () => {
  const rejects: [string, Record<string, unknown>][] = [
    ['agentEvm EIP-55', { agentEvm: getAddress(AGENT) }],
    ['agentEvm upper case', { agentEvm: '0x' + AGENT.slice(2).toUpperCase() }],
    ['agentEvm without 0x', { agentEvm: AGENT.slice(2) }],
    ['agentEvm 0X', { agentEvm: '0X' + AGENT.slice(2) }],
    ['agentEvm 19 bytes', { agentEvm: AGENT.slice(0, -2) }],
    ['agentEvm 32 bytes', { agentEvm: '0x' + '00'.repeat(12) + AGENT.slice(2) }],
    ['keyEpoch 2^32', { keyEpoch: 2 ** 32 }],
    ['keyEpoch -1', { keyEpoch: -1 }],
    ['keyEpoch -0', { keyEpoch: -0 }],
    ['keyEpoch string', { keyEpoch: '3' }],
    ['keyEpoch boolean', { keyEpoch: false }],
    ['keyEpoch 1.5', { keyEpoch: 1.5 }],
    ['keyEpoch bigint', { keyEpoch: 3n }],
    ['nonce number', { nonce: 12345 }],
    ['nonce leading zero', { nonce: '0' + NONCE }],
    ['nonce sign', { nonce: '+' + NONCE }],
    ['nonce negative', { nonce: '-1' }],
    ['nonce hex', { nonce: '0x01' }],
    ['nonce 2^256', { nonce: (UINT256_MAX + 1n).toString() }],
    ['nonce empty', { nonce: '' }],
    ['nonce whitespace', { nonce: NONCE + ' ' }],
    ['nonce bigint', { nonce: 1n }],
    ['deadline 2^53', { deadline: 2 ** 53 }],
    ['deadline -1', { deadline: -1 }],
    ['deadline string', { deadline: '1760003600' }],
    ['a fifth field', { ownerEvm: AGENT }],
  ];
  it.each(rejects)('refuses a Revocation with %s', (_why, change) => {
    expectRefused(() => parseRevocation({ ...REVOCATION, ...change }));
    expectRefused(() => hashRevocation(DOMAIN, { ...REVOCATION, ...change }));
  });

  it('refuses missing fields, accessors and non-plain objects', () => {
    for (const key of Object.keys(REVOCATION)) {
      expectRefused(() => parseRevocation(omit(REVOCATION, key)));
    }
    const getter = { ...REVOCATION };
    Object.defineProperty(getter, 'keyEpoch', { get: () => 3, enumerable: true });
    expectRefused(() => parseRevocation(getter));
    expectRefused(() => parseRevocation([REVOCATION]));
    expectRefused(() => parseRevocation(null));
  });

  it('returns a frozen copy that later changes to the input cannot reach', () => {
    const input = { ...REVOCATION };
    const parsed = parseRevocation(input);
    input.keyEpoch = 9;
    expect(parsed).toEqual(REVOCATION);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
