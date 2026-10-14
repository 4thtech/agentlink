// Suite `nip44` (M1-1g): the official NIP-44 v2 vectors through @agentlink/crypto. The low-level
// functions take a secret key or a conversation key, so they come from the restricted subpath
// @agentlink/crypto/keystore; the KeyStore methods (nip44Encrypt, nip44Decrypt) use the same code
// with the conversation key derived inside. Inputs go to the code under test unchecked, so its own
// refusals (CryptoInputError) are what `outcome: reject` measures; any other error is a bug and
// fails the case.
import { CryptoInputError, encodeUtf8, nip44PaddedLength, sha256 } from '@agentlink/crypto';
import {
  bip340PublicKey,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  nip44MessageKeys,
} from '@agentlink/crypto/keystore';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type Nip44Input =
  | { op: 'conversationKey'; sec1: string; pub2: string }
  | { op: 'conversationKeyPair'; sec1: string; sec2: string }
  | { op: 'messageKeys'; conversationKey: string; nonce: string }
  | { op: 'paddedLength'; length: number }
  | { op: 'encrypt'; conversationKey: string; nonce: string; plaintext: string }
  | { op: 'decrypt'; conversationKey: string; payload: string }
  | { op: 'encryptLong'; conversationKey: string; nonce: string; pattern: string; repeat: number }
  | { op: 'encryptLength'; length: number };

const FIELDS: Readonly<Record<Nip44Input['op'], readonly [string, 'string' | 'number'][]>> = {
  conversationKey: [
    ['sec1', 'string'],
    ['pub2', 'string'],
  ],
  conversationKeyPair: [
    ['sec1', 'string'],
    ['sec2', 'string'],
  ],
  messageKeys: [
    ['conversationKey', 'string'],
    ['nonce', 'string'],
  ],
  paddedLength: [['length', 'number']],
  encrypt: [
    ['conversationKey', 'string'],
    ['nonce', 'string'],
    ['plaintext', 'string'],
  ],
  decrypt: [
    ['conversationKey', 'string'],
    ['payload', 'string'],
  ],
  encryptLong: [
    ['conversationKey', 'string'],
    ['nonce', 'string'],
    ['pattern', 'string'],
    ['repeat', 'number'],
  ],
  encryptLength: [['length', 'number']],
};

function parseInput(input: unknown): Nip44Input {
  const i = input as Record<string, unknown> | null;
  const op = i?.op;
  if (typeof op === 'string' && Object.hasOwn(FIELDS, op)) {
    const fields = FIELDS[op as Nip44Input['op']];
    if (fields.every(([key, type]) => typeof i?.[key] === type)) return i as Nip44Input;
  }
  throw new TypeError('nip44: input does not match any op of case.schema.json');
}

/** Runs `fn`; a CryptoInputError from the code under test is the vector's `reject`. */
function rejectOr(fn: () => readonly Comparison[]): readonly Comparison[] {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

function evaluate(input: Nip44Input): readonly Comparison[] {
  switch (input.op) {
    case 'conversationKey':
      return rejectOr(() => [
        {
          field: 'conversationKey',
          actual: bytesToHex(nip44ConversationKey(hexToBytes(input.sec1), hexToBytes(input.pub2))),
        },
      ]);
    case 'conversationKeyPair': {
      const sec1 = hexToBytes(input.sec1);
      const sec2 = hexToBytes(input.sec2);
      const forward = bytesToHex(nip44ConversationKey(sec1, bip340PublicKey(sec2)));
      const backward = bytesToHex(nip44ConversationKey(sec2, bip340PublicKey(sec1)));
      // NIP-44: the conversation key is symmetric. A mismatch is a bug, not a vector outcome.
      if (forward !== backward) throw new Error('nip44: the conversation key is not symmetric');
      return [{ field: 'conversationKey', actual: forward }];
    }
    case 'messageKeys': {
      const keys = nip44MessageKeys(hexToBytes(input.conversationKey), hexToBytes(input.nonce));
      return [
        { field: 'chachaKey', actual: bytesToHex(keys.chachaKey) },
        { field: 'chachaNonce', actual: bytesToHex(keys.chachaNonce) },
        { field: 'hmacKey', actual: bytesToHex(keys.hmacKey) },
      ];
    }
    case 'paddedLength':
      return [{ field: 'paddedLength', actual: String(nip44PaddedLength(input.length)) }];
    case 'encrypt':
      return [
        {
          field: 'payload',
          actual: nip44EncryptWithKey(
            hexToBytes(input.conversationKey),
            input.plaintext,
            hexToBytes(input.nonce),
          ),
        },
      ];
    case 'decrypt':
      return rejectOr(() => [
        {
          field: 'plaintext',
          actual: nip44DecryptWithKey(hexToBytes(input.conversationKey), input.payload),
        },
      ]);
    case 'encryptLong': {
      const conversationKey = hexToBytes(input.conversationKey);
      const plaintext = input.pattern.repeat(input.repeat);
      const payload = nip44EncryptWithKey(conversationKey, plaintext, hexToBytes(input.nonce));
      // The round trip must give the plaintext back; a mismatch is a bug, not a vector outcome.
      if (nip44DecryptWithKey(conversationKey, payload) !== plaintext) {
        throw new Error('nip44: the long message does not round-trip');
      }
      return [
        { field: 'plaintextSha256', actual: bytesToHex(sha256(encodeUtf8(plaintext))) },
        { field: 'payloadSha256', actual: bytesToHex(sha256(encodeUtf8(payload))) },
      ];
    }
    case 'encryptLength':
      // As the upstream generator: a zero key and nonce, and `length` bytes of "a".
      return rejectOr(() => [
        {
          field: 'payload',
          actual: nip44EncryptWithKey(
            new Uint8Array(32),
            'a'.repeat(input.length),
            new Uint8Array(32),
          ),
        },
      ]);
  }
}

export const nip44: SuiteModule = {
  evaluate(testCase) {
    return Promise.resolve(evaluate(parseInput(testCase.input)));
  },
};
