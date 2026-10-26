// Suite `card-pop` (M1-1h-f): the agent card's proof of possession through @4thtech-io/crypto and
// the strict schemas of @4thtech-io/types (04 §2.9, §3.4.1; 07 §8; D-102). A refusal by the code
// under test (CryptoInputError) or a verification that returns false is `outcome: reject`; any other
// error is a bug and fails the case.
import {
  CryptoInputError,
  TAGS,
  agentCardJcsHash,
  taggedHash,
  verifyCardPop,
  verifyCardPossession,
} from '@4thtech-io/crypto';
import { signCardPop } from '@4thtech-io/crypto/keystore';
import { cardUpdateBodySchema, proofPackSignerSchema } from '@4thtech-io/types';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type CardPopInput =
  | { op: 'cardPopMessage'; card: unknown }
  | { op: 'signCardPop'; card: unknown; secretKey: string; auxRand: string }
  | { op: 'verifyCardPop'; card: unknown; cardPop: unknown }
  | { op: 'verifyCardPossession'; card: unknown; cardAgentSig: unknown; cardPop: unknown }
  | { op: 'signerShape'; signer: unknown }
  | { op: 'cardUpdateShape'; body: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isBytes32 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function parseInput(input: unknown): CardPopInput {
  if (isObject(input)) {
    const i = input;
    switch (i.op) {
      case 'cardPopMessage':
        return { op: i.op, card: i.card };
      case 'signCardPop':
        if (isBytes32(i.secretKey) && isBytes32(i.auxRand)) {
          return { op: i.op, card: i.card, secretKey: i.secretKey, auxRand: i.auxRand };
        }
        break;
      case 'verifyCardPop':
        if ('cardPop' in i) return { op: i.op, card: i.card, cardPop: i.cardPop };
        break;
      case 'verifyCardPossession':
        // An absent field stays undefined: the case tests one signature without the other.
        return { op: i.op, card: i.card, cardAgentSig: i.cardAgentSig, cardPop: i.cardPop };
      case 'signerShape':
        return { op: i.op, signer: i.signer };
      case 'cardUpdateShape':
        return { op: i.op, body: i.body };
    }
  }
  throw new TypeError(
    'card-pop: input does not match any op of test-vectors/card-pop/case.schema.json',
  );
}

const outcome = (accepted: boolean): readonly Comparison[] => [
  { field: 'outcome', actual: accepted ? 'accept' : 'reject' },
];

function evaluate(input: CardPopInput): readonly Comparison[] {
  switch (input.op) {
    case 'cardPopMessage': {
      const cardHash = agentCardJcsHash(input.card);
      return [
        { field: 'tag', actual: TAGS.cardPop },
        { field: 'cardHash', actual: bytesToHex(cardHash) },
        { field: 'message', actual: bytesToHex(taggedHash(TAGS.cardPop, cardHash)) },
      ];
    }
    case 'signCardPop':
      try {
        return [
          {
            field: 'cardPop',
            actual: bytesToHex(
              signCardPop(hexToBytes(input.secretKey), input.card, hexToBytes(input.auxRand)),
            ),
          },
        ];
      } catch (error) {
        if (error instanceof CryptoInputError) return outcome(false);
        throw error;
      }
    case 'verifyCardPop':
      return outcome(verifyCardPop(input.card, input.cardPop));
    case 'verifyCardPossession':
      return outcome(verifyCardPossession(input.card, input.cardAgentSig, input.cardPop));
    case 'signerShape':
      return outcome(proofPackSignerSchema.safeParse(input.signer).success);
    case 'cardUpdateShape':
      return outcome(cardUpdateBodySchema.safeParse(input.body).success);
  }
}

export const cardPop: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
