// Suite `hkdf-derive` (M1-1b): 04 §2.1 key derivation through @agentlink/crypto. `hkdf` is RFC 5869
// HKDF-SHA256; `derive` is the raw okm for (masterSeed, label, epoch, counter); `key` is the public
// key of (label, epoch) after the secp256k1 rejection loop; `agentId` is 04 §2.9. Inputs go to the
// code under test unchecked, so its own refusals (CryptoInputError) are what `outcome: reject`
// measures; any other error is a bug and fails the case.
import {
  CryptoInputError,
  KEY_LABELS,
  deriveAgentId,
  deriveKey,
  derivePublicKey,
  encodeBase64url,
  evmAddressChecksummed,
  hkdfSha256,
  type KeyLabel,
} from '@agentlink/crypto';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

type HkdfDeriveInput =
  | { op: 'hkdf'; ikm: string; salt: string; info: string; length: number }
  | { op: 'derive'; masterSeed: string; label: string; epoch: number; counter: number }
  | { op: 'key'; masterSeed: string; label: string; epoch: number }
  | { op: 'agentId'; masterSeed: string };

function parseInput(input: unknown): HkdfDeriveInput {
  const i = input as Record<string, unknown> | null;
  const str = (key: string): boolean => typeof i?.[key] === 'string';
  const num = (key: string): boolean => typeof i?.[key] === 'number';
  if (i?.op === 'hkdf' && str('ikm') && str('salt') && str('info') && num('length')) {
    return i as HkdfDeriveInput;
  }
  if (i?.op === 'derive' && str('masterSeed') && str('label') && num('epoch') && num('counter')) {
    return i as HkdfDeriveInput;
  }
  if (i?.op === 'key' && str('masterSeed') && str('label') && num('epoch')) {
    return i as HkdfDeriveInput;
  }
  if (i?.op === 'agentId' && str('masterSeed')) return i as HkdfDeriveInput;
  throw new TypeError('hkdf-derive: input does not match any op of case.schema.json');
}

function rejectedOr(run: () => readonly Comparison[]): readonly Comparison[] {
  try {
    return run();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

function publicKeyComparisons(masterSeed: string, label: string, epoch: number): Comparison[] {
  // The label is passed through unchecked: refusing an unknown label is the code's job.
  const key = derivePublicKey(hexToBytes(masterSeed), label as KeyLabel, epoch);
  switch (key.label) {
    case KEY_LABELS.evm:
      return [
        { field: 'address', actual: key.agentId },
        { field: 'addressChecksummed', actual: evmAddressChecksummed(key.agentId) },
      ];
    case KEY_LABELS.enc:
      return [
        { field: 'publicKey', actual: bytesToHex(key.publicKey) },
        { field: 'kid', actual: encodeBase64url(key.kid) },
      ];
    default:
      return [{ field: 'publicKey', actual: bytesToHex(key.publicKey) }];
  }
}

function evaluateInput(input: HkdfDeriveInput): readonly Comparison[] {
  switch (input.op) {
    case 'hkdf': {
      const okm = hkdfSha256(
        hexToBytes(input.ikm),
        hexToBytes(input.salt),
        hexToBytes(input.info),
        input.length,
      );
      return [{ field: 'okm', actual: bytesToHex(okm) }];
    }
    case 'derive': {
      const seed = hexToBytes(input.masterSeed);
      const okm = deriveKey(seed, input.label as KeyLabel, input.epoch, input.counter);
      return [{ field: 'okm', actual: bytesToHex(okm) }];
    }
    case 'key':
      return publicKeyComparisons(input.masterSeed, input.label, input.epoch);
    case 'agentId':
      return [{ field: 'agentId', actual: deriveAgentId(hexToBytes(input.masterSeed)) }];
  }
}

export const hkdfDerive: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    return Promise.resolve(rejectedOr(() => evaluateInput(input)));
  },
};
