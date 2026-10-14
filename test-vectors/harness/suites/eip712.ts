// Suite `eip712` (M1-1e): EIP-712 typed-data hashing, canonical ECDSA and the AgentCard through
// @agentlink/crypto (04 §2.4, §2.4.1, §2.9). A refusal by the code under test (CryptoInputError) is
// reported as `outcome: reject`; a verification that returns false is `outcome: reject` too. Any
// other error is a bug and fails the case.
import {
  CryptoInputError,
  agentCardNameHash,
  agentCardRelaysHash,
  encodeHex0x,
  hashAgentCard,
  hashTypedData,
  parseAgentCardJson,
  signAgentCard,
  signTypedData,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type TypedData,
} from '@agentlink/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type Eip712Input =
  | { op: 'typedData'; typedData: TypedData }
  | { op: 'signTypedData'; typedData: TypedData; secretKey: string }
  | { op: 'agentCard'; card: unknown }
  | { op: 'agentCardJson'; json: string }
  | { op: 'cardHashes'; name: string; relays: string[] }
  | { op: 'signAgentCard' | 'signCardAgent'; card: unknown; secretKey: string }
  | { op: 'verifyAgentCard'; card: unknown; cardSig: unknown }
  | { op: 'verifyCardAgentSig'; card: unknown; cardAgentSig: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function parseInput(input: unknown): Eip712Input {
  if (isObject(input)) {
    const i = input;
    switch (i.op) {
      case 'typedData':
        if (isObject(i.typedData))
          return { op: i.op, typedData: i.typedData as unknown as TypedData };
        break;
      case 'signTypedData':
        if (isObject(i.typedData) && isKey(i.secretKey)) {
          return {
            op: i.op,
            typedData: i.typedData as unknown as TypedData,
            secretKey: i.secretKey,
          };
        }
        break;
      case 'agentCard':
        return { op: i.op, card: i.card };
      case 'agentCardJson':
        if (typeof i.json === 'string') return { op: i.op, json: i.json };
        break;
      case 'cardHashes':
        if (
          typeof i.name === 'string' &&
          Array.isArray(i.relays) &&
          i.relays.every((r) => typeof r === 'string')
        ) {
          return { op: i.op, name: i.name, relays: i.relays as string[] };
        }
        break;
      case 'signAgentCard':
      case 'signCardAgent':
        if (isKey(i.secretKey)) return { op: i.op, card: i.card, secretKey: i.secretKey };
        break;
      case 'verifyAgentCard':
        return { op: i.op, card: i.card, cardSig: i.cardSig };
      case 'verifyCardAgentSig':
        return { op: i.op, card: i.card, cardAgentSig: i.cardAgentSig };
    }
  }
  throw new TypeError(
    'eip712: input does not match any op of test-vectors/eip712/case.schema.json',
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

const outcome = (accepted: boolean): readonly Comparison[] => [
  { field: 'outcome', actual: accepted ? 'accept' : 'reject' },
];

function evaluate(input: Eip712Input): readonly Comparison[] {
  switch (input.op) {
    case 'typedData': {
      const hashes = hashTypedData(input.typedData);
      return [
        { field: 'domainSeparator', actual: bytesToHex(hashes.domainSeparator) },
        { field: 'structHash', actual: bytesToHex(hashes.structHash) },
        { field: 'digest', actual: bytesToHex(hashes.digest) },
      ];
    }
    case 'signTypedData':
      return [
        { field: 'signature', actual: signTypedData(input.typedData, hexToBytes(input.secretKey)) },
      ];
    case 'agentCard':
      return rejectedOr(() => {
        const hashes = hashAgentCard(input.card);
        return [
          { field: 'typeHash', actual: bytesToHex(hashes.typeHash) },
          { field: 'domainSeparator', actual: bytesToHex(hashes.domainSeparator) },
          { field: 'structHash', actual: bytesToHex(hashes.structHash) },
          { field: 'digest', actual: bytesToHex(hashes.digest) },
        ];
      });
    case 'agentCardJson':
      return rejectedOr(() => [
        {
          field: 'digest',
          actual: bytesToHex(hashAgentCard(parseAgentCardJson(input.json)).digest),
        },
      ]);
    case 'cardHashes':
      return [
        { field: 'nameHash', actual: encodeHex0x(agentCardNameHash(input.name)) },
        { field: 'relaysHash', actual: encodeHex0x(agentCardRelaysHash(input.relays)) },
      ];
    case 'signAgentCard':
      return [{ field: 'cardSig', actual: signAgentCard(input.card, hexToBytes(input.secretKey)) }];
    case 'signCardAgent':
      return [
        { field: 'cardAgentSig', actual: signAgentCard(input.card, hexToBytes(input.secretKey)) },
      ];
    case 'verifyAgentCard':
      return outcome(verifyCardOwnerSig(input.card, input.cardSig));
    case 'verifyCardAgentSig':
      return outcome(verifyCardAgentSig(input.card, input.cardAgentSig));
  }
}

export const eip712: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
