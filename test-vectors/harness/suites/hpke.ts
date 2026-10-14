// Suite `hpke` (M1-1c): RFC 9180 HPKE, mode Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
// AES-256-GCM through @agentlink/crypto. `sealSequence` and `open` drive the raw suite (the CFRG
// vector) through the test seam; `wrapCek` and `unwrapCek` are the 04 §3.3 CEK wrap, with the
// ephemeral key fixed through the test seam for `wrapCek`. Inputs go to the code under test
// unchecked, so its own refusals (CryptoInputError) are what `outcome: reject` measures; any other
// error is a bug and fails the case.
import { CryptoInputError, decodeBase64url, encodeBase64url } from '@agentlink/crypto';
import { unwrapCek } from '@agentlink/crypto/keystore';
import { hpkeOpen, hpkeSealSequence, wrapCekWithEphemeralKey } from '@agentlink/crypto/testing';
import { bytesToHex, hexToBytes } from '../hex';
import type { Comparison, SuiteModule } from '../suite';

interface Message {
  aad: string;
  plaintext: string;
}

type HpkeInput =
  | {
      op: 'sealSequence';
      recipientPublicKey: string;
      ephemeralSecretKey: string;
      info: string;
      messages: Message[];
    }
  | {
      op: 'open';
      recipientSecretKey: string;
      enc: string;
      info: string;
      aad: string;
      ciphertext: string;
    }
  | {
      op: 'wrapCek';
      recipientPublicKey: string;
      ephemeralSecretKey: string;
      envelopeId: string;
      cek: string;
    }
  | { op: 'unwrapCek'; recipientSecretKey: string; envelopeId: string; enc: string; wk: string };

function parseInput(input: unknown): HpkeInput {
  const i = input as Record<string, unknown> | null;
  const str = (...keys: string[]): boolean => keys.every((key) => typeof i?.[key] === 'string');
  const isMessage = (m: unknown): boolean =>
    typeof (m as Message | null)?.aad === 'string' &&
    typeof (m as Message | null)?.plaintext === 'string';
  if (
    i?.op === 'sealSequence' &&
    str('recipientPublicKey', 'ephemeralSecretKey', 'info') &&
    Array.isArray(i.messages) &&
    i.messages.every(isMessage)
  ) {
    return i as HpkeInput;
  }
  if (i?.op === 'open' && str('recipientSecretKey', 'enc', 'info', 'aad', 'ciphertext')) {
    return i as HpkeInput;
  }
  if (i?.op === 'wrapCek' && str('recipientPublicKey', 'ephemeralSecretKey', 'envelopeId', 'cek')) {
    return i as HpkeInput;
  }
  if (i?.op === 'unwrapCek' && str('recipientSecretKey', 'envelopeId', 'enc', 'wk')) {
    return i as HpkeInput;
  }
  throw new TypeError('hpke: input does not match any op of case.schema.json');
}

async function rejectedOr(
  run: () => Promise<readonly Comparison[]>,
): Promise<readonly Comparison[]> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CryptoInputError) return [{ field: 'outcome', actual: 'reject' }];
    throw error;
  }
}

async function evaluateInput(input: HpkeInput): Promise<readonly Comparison[]> {
  switch (input.op) {
    case 'sealSequence': {
      const sealed = await hpkeSealSequence(
        hexToBytes(input.recipientPublicKey),
        hexToBytes(input.ephemeralSecretKey),
        hexToBytes(input.info),
        input.messages.map((m) => ({ aad: hexToBytes(m.aad), plaintext: hexToBytes(m.plaintext) })),
      );
      return [
        { field: 'enc', actual: bytesToHex(sealed.enc) },
        ...sealed.ciphertexts.map((ct, index) => ({
          field: `ciphertext${index}`,
          actual: bytesToHex(ct),
        })),
      ];
    }
    case 'open': {
      const plaintext = await hpkeOpen(
        hexToBytes(input.recipientSecretKey),
        hexToBytes(input.enc),
        hexToBytes(input.info),
        hexToBytes(input.aad),
        hexToBytes(input.ciphertext),
      );
      return [{ field: 'plaintext', actual: bytesToHex(plaintext) }];
    }
    case 'wrapCek': {
      // The id is decoded without a length, so a wrong-length id reaches the code under test.
      const wrapped = await wrapCekWithEphemeralKey(
        hexToBytes(input.recipientPublicKey),
        decodeBase64url(input.envelopeId),
        hexToBytes(input.cek),
        hexToBytes(input.ephemeralSecretKey),
      );
      return [
        { field: 'enc', actual: encodeBase64url(wrapped.enc) },
        { field: 'wk', actual: encodeBase64url(wrapped.wk) },
      ];
    }
    case 'unwrapCek': {
      const cek = await unwrapCek(
        hexToBytes(input.recipientSecretKey),
        decodeBase64url(input.envelopeId),
        {
          enc: decodeBase64url(input.enc),
          wk: decodeBase64url(input.wk),
        },
      );
      return [{ field: 'cek', actual: bytesToHex(cek) }];
    }
  }
}

export const hpke: SuiteModule = {
  evaluate(testCase) {
    const input = parseInput(testCase.input);
    return rejectedOr(() => evaluateInput(input));
  },
};
