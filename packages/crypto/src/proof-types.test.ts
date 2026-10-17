// M1-1j: the OCC v2 proof types (05 §3.1, §4; 04 §5), the recipient commitment and the EIP-3009
// `ReceiveWithAuthorization` typed data. Checked against the 05 §3.1 / §4 struct text and,
// differentially, against viem (a devDependency used only as an oracle here). The independent
// vectors are the `eip712-proof` suite in test-vectors/.
import {
  encodeAbiParameters,
  getAddress,
  hashTypedData as viemHashTypedData,
  keccak256 as viemKeccak256,
  type TypedDataDefinition,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  OCC_V2_DOMAIN_NAME,
  OCC_V2_DOMAIN_VERSION,
  RECEIPT_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  RECORD_TYPES,
  REGISTRATION_TYPES,
  decodeHex0x,
  eip712EncodeType,
  encodeHex,
  encodeHex0x,
  hashReceipt,
  hashReceiveWithAuthorization,
  hashRecord,
  hashRegistration,
  occV2Domain,
  parseReceipt,
  parseReceiveWithAuthorization,
  parseRecord,
  parseRegistration,
  receiptTypedData,
  receiveWithAuthorizationTypedData,
  recipientCommitment,
  recordStructHash,
  recordTypedData,
  registrationTypedData,
} from './index.js';

const hex32 = (byte: string): string => '0x' + byte.repeat(32);
const NOTARY = '0x252d9a9c22652a8c08b12eda14d30906850542c9';
const REGISTRY = '0xc3c7797dd554c8de871aa72b40882764803eb675';
const SIGNER = '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a';
const RECIPIENT = '0xe09a6724ce75ed0badc4bb6a5ecf4f28e75ee558';
const TOKEN = '0x05f7cddba6070777972ad9ff9df5312872a49685';
const SALT = '0xb529be83d68c21c739ecccae31d44b853b51551a9c436f57bbc617da4a287731';

const DOMAIN = { name: 'OCC', version: '2', chainId: 84532, verifyingContract: NOTARY };

const RECORD = {
  signer: SIGNER,
  envelopeHash: hex32('38'),
  recipientCommitment: hex32('df'),
  parentRecordId: hex32('00'),
  appId: hex32('00'),
  kind: 1,
  feeToken: TOKEN,
  maxFee: '250000',
  nonce: '53413080818580974331135570314775698628850412394171742376625802275545193048131',
  deadline: 1760003600,
};

const RECEIPT = {
  signer: RECIPIENT,
  recordId: hex32('e2'),
  receiptType: 1,
  salt: SALT,
  deadline: 1760090000,
};

const REGISTRATION = {
  cardHash: hex32('b6'),
  feeToken: TOKEN,
  maxFee: '1000000',
  appId: hex32('00'),
  nonce: '78219569170084842465697082356206593203654915056229411319944921062164124938175',
  deadline: 1760003600,
};

const AUTH = {
  from: RECIPIENT,
  to: NOTARY,
  value: '5000000',
  validAfter: '0',
  validBefore: '1760003600',
  nonce: hex32('7a'),
};
// A token domain as read from chain: name and version are the token's, never hard-coded here.
const TOKEN_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 84532,
  verifyingContract: getAddress(TOKEN),
};

const UINT256_MAX = (1n << 256n) - 1n;

const viemDigest = (
  types: Record<string, readonly { name: string; type: string }[]>,
  primaryType: string,
  domain: Record<string, unknown>,
  message: Record<string, unknown>,
): string => {
  const { EIP712Domain: _domain, ...rest } = types;
  return viemHashTypedData({
    types: rest,
    primaryType,
    domain,
    message,
  } as unknown as TypedDataDefinition).slice(2);
};

const expectRefused = (run: () => unknown): void => {
  expect(run).toThrow(CryptoInputError);
};

describe('types (05 §3.1, §4; EIP-3009)', () => {
  it('encode the structs exactly as 05 §3.1 and §4 declare them', () => {
    expect(eip712EncodeType(RECORD_TYPES, 'Record')).toBe(
      'Record(address signer,bytes32 envelopeHash,bytes32 recipientCommitment,bytes32 parentRecordId,bytes32 appId,uint8 kind,address feeToken,uint256 maxFee,uint256 nonce,uint64 deadline)',
    );
    expect(eip712EncodeType(RECEIPT_TYPES, 'Receipt')).toBe(
      'Receipt(address signer,bytes32 recordId,uint8 receiptType,bytes32 salt,uint64 deadline)',
    );
    expect(eip712EncodeType(REGISTRATION_TYPES, 'Registration')).toBe(
      'Registration(bytes32 cardHash,address feeToken,uint256 maxFee,bytes32 appId,uint256 nonce,uint64 deadline)',
    );
    expect(eip712EncodeType(RECEIVE_WITH_AUTHORIZATION_TYPES, 'ReceiveWithAuthorization')).toBe(
      'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
    );
  });

  it('use the four-field OCC v2 domain', () => {
    expect(OCC_V2_DOMAIN_NAME).toBe('OCC');
    expect(OCC_V2_DOMAIN_VERSION).toBe('2');
    expect(occV2Domain(84532, NOTARY)).toEqual(DOMAIN);
    expect(Object.isFrozen(occV2Domain(84532, NOTARY))).toBe(true);
    for (const types of [RECORD_TYPES, RECEIPT_TYPES, REGISTRATION_TYPES]) {
      expect(types.EIP712Domain?.map((f) => f.name)).toEqual([
        'name',
        'version',
        'chainId',
        'verifyingContract',
      ]);
    }
  });
});

describe('hashRecord, hashReceipt, hashRegistration', () => {
  it('match viem on the canonical JSON form', () => {
    const bigRecord = { ...RECORD, maxFee: BigInt(RECORD.maxFee), nonce: BigInt(RECORD.nonce) };
    expect(encodeHex(hashRecord(DOMAIN, RECORD).digest)).toBe(
      viemDigest(RECORD_TYPES, 'Record', DOMAIN, bigRecord),
    );
    expect(encodeHex(hashReceipt(DOMAIN, RECEIPT).digest)).toBe(
      viemDigest(RECEIPT_TYPES, 'Receipt', DOMAIN, RECEIPT),
    );
    const regDomain = { ...DOMAIN, verifyingContract: REGISTRY };
    const bigReg = {
      ...REGISTRATION,
      maxFee: BigInt(REGISTRATION.maxFee),
      nonce: BigInt(REGISTRATION.nonce),
    };
    expect(encodeHex(hashRegistration(regDomain, REGISTRATION).digest)).toBe(
      viemDigest(REGISTRATION_TYPES, 'Registration', regDomain, bigReg),
    );
  });

  it('accept every field at its maximum', () => {
    const max = {
      ...RECORD,
      kind: 255,
      maxFee: UINT256_MAX.toString(),
      nonce: UINT256_MAX.toString(),
      deadline: Number.MAX_SAFE_INTEGER,
    };
    const big = { ...max, maxFee: UINT256_MAX, nonce: UINT256_MAX };
    expect(encodeHex(hashRecord(DOMAIN, max).digest)).toBe(
      viemDigest(RECORD_TYPES, 'Record', DOMAIN, big),
    );
  });

  it('return the type hash, and a struct hash independent of the domain', () => {
    const a = hashRecord(DOMAIN, RECORD);
    const b = hashRecord({ ...DOMAIN, chainId: 10200 }, RECORD);
    expect(a.structHash).toEqual(b.structHash);
    expect(a.domainSeparator).not.toEqual(b.domainSeparator);
    expect(a.digest).not.toEqual(b.digest);
    expect(a.typeHash).toHaveLength(32);
    expect(recordStructHash(RECORD)).toEqual(a.structHash);
  });

  it('typed-data builders carry the parsed message with uint256 as bigint', () => {
    const td = recordTypedData(DOMAIN, RECORD);
    expect(td.primaryType).toBe('Record');
    expect(td.message.maxFee).toBe(250000n);
    expect(td.message.nonce).toBe(BigInt(RECORD.nonce));
    expect(Object.isFrozen(td.message)).toBe(true);
    expect(receiptTypedData(DOMAIN, RECEIPT).primaryType).toBe('Receipt');
    expect(registrationTypedData(DOMAIN, REGISTRATION).primaryType).toBe('Registration');
  });

  it('refuse a domain other than the OCC v2 chain domain', () => {
    expectRefused(() => hashRecord({ ...DOMAIN, name: 'OCC2' }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, version: '1' }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, chainId: 0 }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, chainId: '84532' }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, chainId: 2 ** 53 }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, verifyingContract: getAddress(NOTARY) }, RECORD));
    expectRefused(() => hashRecord({ ...DOMAIN, salt: hex32('00') }, RECORD));
    const { verifyingContract: _vc, ...noContract } = DOMAIN;
    expectRefused(() => hashRecord(noContract, RECORD));
    expectRefused(() => hashRecord(null, RECORD));
    expectRefused(() => occV2Domain(84532, getAddress(NOTARY)));
  });
});

describe('parseRecord, parseReceipt, parseRegistration (05 §3.1 JSON form, 04 §2.4.1)', () => {
  const recordRejects: [string, Record<string, unknown>][] = [
    ['maxFee as a number', { maxFee: 250000 }],
    ['maxFee with a leading zero', { maxFee: '0250000' }],
    ['maxFee with a sign', { maxFee: '+1' }],
    ['maxFee negative', { maxFee: '-1' }],
    ['maxFee fraction', { maxFee: '1.0' }],
    ['maxFee exponent', { maxFee: '2.5e5' }],
    ['maxFee whitespace', { maxFee: ' 1' }],
    ['maxFee empty', { maxFee: '' }],
    ['maxFee as a bigint', { maxFee: 1n }],
    ['nonce 2^256', { nonce: (UINT256_MAX + 1n).toString() }],
    ['nonce as hex', { nonce: '0x01' }],
    ['signer EIP-55', { signer: getAddress(SIGNER) }],
    ['signer without 0x', { signer: SIGNER.slice(2) }],
    ['feeToken 0X', { feeToken: '0X' + TOKEN.slice(2) }],
    ['envelopeHash upper case', { envelopeHash: '0x' + 'AB'.repeat(32) }],
    ['envelopeHash bare', { envelopeHash: 'ab'.repeat(32) }],
    ['recipientCommitment 31 bytes', { recipientCommitment: '0x' + 'ab'.repeat(31) }],
    ['parentRecordId 0x0', { parentRecordId: '0x0' }],
    ['appId as bytes', { appId: new Uint8Array(32) }],
    ['kind 256', { kind: 256 }],
    ['kind string', { kind: '1' }],
    ['kind boolean', { kind: true }],
    ['kind -0', { kind: -0 }],
    ['kind 1.5', { kind: 1.5 }],
    ['deadline 2^53', { deadline: 2 ** 53 }],
    ['deadline -1', { deadline: -1 }],
    ['deadline string', { deadline: '1760003600' }],
    ['deadline bigint', { deadline: 1n }],
    ['an extra field', { extra: 1 }],
  ];
  it.each(recordRejects)('refuses a Record with %s', (_why, change) => {
    expectRefused(() => parseRecord({ ...RECORD, ...change }));
    expectRefused(() => hashRecord(DOMAIN, { ...RECORD, ...change }));
  });

  it('refuses a missing field, accessors, symbols and non-plain objects', () => {
    const { nonce: _n, ...missing } = RECORD;
    expectRefused(() => parseRecord(missing));
    const getter = { ...RECORD };
    Object.defineProperty(getter, 'kind', { get: () => 1, enumerable: true });
    expectRefused(() => parseRecord(getter));
    expectRefused(() => parseRecord({ ...RECORD, [Symbol('x')]: 1 }));
    expectRefused(() => parseRecord(Object.assign(Object.create({ x: 1 }) as object, RECORD)));
    expectRefused(() => parseRecord([RECORD]));
    expectRefused(() => parseRecord(null));
  });

  it('returns a frozen copy that later changes to the input cannot reach', () => {
    const input = { ...RECORD };
    const parsed = parseRecord(input);
    input.kind = 2;
    expect(parsed.kind).toBe(1);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('refuses non-canonical Receipt fields', () => {
    const rejects: Record<string, unknown>[] = [
      { recordId: 'AAAA' },
      { recordId: '0x' + 'E2'.repeat(32) },
      { salt: '0x' + 'ab'.repeat(33) },
      { signer: getAddress(RECIPIENT) },
      { receiptType: 256 },
      { receiptType: '1' },
      { deadline: 2 ** 53 },
      { extra: 1 },
    ];
    for (const change of rejects) expectRefused(() => parseReceipt({ ...RECEIPT, ...change }));
    const { salt: _s, ...missing } = RECEIPT;
    expectRefused(() => parseReceipt(missing));
    expect(parseReceipt(RECEIPT)).toEqual(RECEIPT);
  });

  it('parses Registration with the same rules', () => {
    expect(parseRegistration(REGISTRATION)).toEqual(REGISTRATION);
    expectRefused(() => parseRegistration({ ...REGISTRATION, maxFee: 1 }));
    expectRefused(() => parseRegistration({ ...REGISTRATION, cardHash: hex32('AB') }));
    expectRefused(() => parseRegistration({ ...REGISTRATION, extra: 1 }));
  });
});

describe('recipientCommitment (04 §5)', () => {
  it('is keccak256(abi.encode(recipientAgentEvm, salt))', () => {
    const expected = viemKeccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [RECIPIENT, SALT as `0x${string}`],
      ),
    );
    expect(encodeHex0x(recipientCommitment(RECIPIENT, SALT))).toBe(expected);
    const saltBytes = decodeHex0x(SALT);
    expect(encodeHex0x(recipientCommitment(RECIPIENT, saltBytes))).toBe(expected);
  });

  it('refuses non-canonical inputs', () => {
    expectRefused(() => recipientCommitment(getAddress(RECIPIENT), SALT));
    expectRefused(() => recipientCommitment(RECIPIENT.slice(2), SALT));
    expectRefused(() => recipientCommitment(RECIPIENT, SALT.slice(2)));
    expectRefused(() => recipientCommitment(RECIPIENT, '0x' + 'ab'.repeat(31)));
    expectRefused(() => recipientCommitment(RECIPIENT, new Uint8Array(31)));
    expectRefused(() => recipientCommitment(RECIPIENT, SALT.toUpperCase().replace('0X', '0x')));
  });
});

describe('EIP-3009 ReceiveWithAuthorization', () => {
  it('matches viem under a token domain given by the caller', () => {
    const big = {
      ...AUTH,
      value: BigInt(AUTH.value),
      validAfter: BigInt(AUTH.validAfter),
      validBefore: BigInt(AUTH.validBefore),
    };
    expect(encodeHex(hashReceiveWithAuthorization(TOKEN_DOMAIN, AUTH).digest)).toBe(
      viemDigest(RECEIVE_WITH_AUTHORIZATION_TYPES, 'ReceiveWithAuthorization', TOKEN_DOMAIN, big),
    );
    const td = receiveWithAuthorizationTypedData(TOKEN_DOMAIN, AUTH);
    expect(td.primaryType).toBe('ReceiveWithAuthorization');
    expect(td.domain.name).toBe('USD Coin');
  });

  it('refuses a token domain that is not four well-formed fields', () => {
    expectRefused(() =>
      hashReceiveWithAuthorization({ ...TOKEN_DOMAIN, verifyingContract: TOKEN.toUpperCase() }, AUTH),
    );
    const badChecksum =
      TOKEN_DOMAIN.verifyingContract.slice(0, 2) +
      [...TOKEN_DOMAIN.verifyingContract.slice(2)]
        .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
        .join('');
    expectRefused(() =>
      hashReceiveWithAuthorization({ ...TOKEN_DOMAIN, verifyingContract: badChecksum }, AUTH),
    );
    expectRefused(() => hashReceiveWithAuthorization({ ...TOKEN_DOMAIN, chainId: 0 }, AUTH));
    expectRefused(() => hashReceiveWithAuthorization({ ...TOKEN_DOMAIN, name: 1 }, AUTH));
    expectRefused(() => hashReceiveWithAuthorization({ ...TOKEN_DOMAIN, extra: 'x' }, AUTH));
    const { version: _v, ...noVersion } = TOKEN_DOMAIN;
    expectRefused(() => hashReceiveWithAuthorization(noVersion, AUTH));
  });

  it('refuses a non-canonical authorization', () => {
    const rejects: Record<string, unknown>[] = [
      { value: 5000000 },
      { value: '05000000' },
      { validBefore: '-1' },
      { nonce: '7a'.repeat(32) },
      { nonce: '1' },
      { from: getAddress(RECIPIENT) },
      { to: NOTARY.slice(2) },
      { extra: 1 },
    ];
    for (const change of rejects) {
      expectRefused(() => parseReceiveWithAuthorization({ ...AUTH, ...change }));
    }
    expect(parseReceiveWithAuthorization(AUTH)).toEqual(AUTH);
  });
});
