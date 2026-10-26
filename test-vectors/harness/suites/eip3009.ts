// Suite `eip3009` (M3-4b-t-1): the EIP-3009 `ReceiveWithAuthorization` typed data under a token's
// own domain, the check of that domain against what the token reports on chain, and its signature
// by the agent EVM key, through @4thtech-io/crypto. A refusal by the code under test
// (CryptoInputError) is reported as `outcome: reject`. Any other error is a bug and fails the case.
import {
  CryptoInputError,
  RECEIVE_WITH_AUTHORIZATION_TYPE_HASH,
  hashReceiveWithAuthorization,
  receiveWithAuthorizationTypedData,
  tokenDomainSeparator,
  verifyTokenDomain,
  type ProofTypeHashes,
} from '@4thtech-io/crypto';
import { signTypedData } from '@4thtech-io/crypto/keystore';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type Eip3009Input =
  | { op: 'typeHashConstant' }
  | { op: 'domainSeparator'; domain: unknown }
  | { op: 'verifyTokenDomain'; expected: unknown; reading: unknown }
  | { op: 'receiveWithAuthorization'; domain: unknown; authorization: unknown }
  | {
      op: 'signReceiveWithAuthorization';
      domain: unknown;
      authorization: unknown;
      secretKey: string;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function parseInput(input: unknown): Eip3009Input {
  if (isObject(input)) {
    const i = input;
    switch (i.op) {
      case 'typeHashConstant':
        return { op: i.op };
      case 'domainSeparator':
        if ('domain' in i) return { op: i.op, domain: i.domain };
        break;
      case 'verifyTokenDomain':
        if ('expected' in i && 'reading' in i) {
          return { op: i.op, expected: i.expected, reading: i.reading };
        }
        break;
      case 'receiveWithAuthorization':
        if ('domain' in i && 'authorization' in i) {
          return { op: i.op, domain: i.domain, authorization: i.authorization };
        }
        break;
      case 'signReceiveWithAuthorization':
        if ('domain' in i && 'authorization' in i && isKey(i.secretKey)) {
          return {
            op: i.op,
            domain: i.domain,
            authorization: i.authorization,
            secretKey: i.secretKey,
          };
        }
        break;
    }
  }
  throw new TypeError(
    'eip3009: input does not match any op of test-vectors/eip3009/case.schema.json',
  );
}

function rejectedOr(run: () => readonly Comparison[]): readonly Comparison[] {
  try {
    return run();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

const hashFields = (hashes: ProofTypeHashes): readonly Comparison[] => [
  { field: 'typeHash', actual: bytesToHex(hashes.typeHash) },
  { field: 'domainSeparator', actual: bytesToHex(hashes.domainSeparator) },
  { field: 'structHash', actual: bytesToHex(hashes.structHash) },
  { field: 'digest', actual: bytesToHex(hashes.digest) },
];

function evaluate(input: Eip3009Input): readonly Comparison[] {
  switch (input.op) {
    case 'typeHashConstant':
      return [{ field: 'typeHash', actual: RECEIVE_WITH_AUTHORIZATION_TYPE_HASH.slice(2) }];
    case 'domainSeparator':
      return rejectedOr(() => [
        { field: 'domainSeparator', actual: bytesToHex(tokenDomainSeparator(input.domain)) },
      ]);
    case 'verifyTokenDomain':
      return rejectedOr(() => {
        const domain = verifyTokenDomain(input.expected, input.reading);
        return [
          { field: 'outcome', actual: 'accept' },
          { field: 'name', actual: domain.name },
          { field: 'version', actual: domain.version },
          { field: 'domainSeparator', actual: bytesToHex(tokenDomainSeparator(domain)) },
        ];
      });
    case 'receiveWithAuthorization':
      return rejectedOr(() =>
        hashFields(hashReceiveWithAuthorization(input.domain, input.authorization)),
      );
    case 'signReceiveWithAuthorization':
      return [
        {
          field: 'signature',
          actual: signTypedData(
            receiveWithAuthorizationTypedData(input.domain, input.authorization),
            hexToBytes(input.secretKey),
          ),
        },
      ];
  }
}

export const eip3009: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
