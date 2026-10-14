// 04 §2.8 password(secret, secretKind): the Argon2id password for a generated code (kind 1) or a
// chosen passphrase (kind 2), shared by ALKS, ALKO and the recovery code (04 §2.3); and the generated
// 120-bit code itself. Secrets stay in Uint8Array. Kind 2 needs a JS string for NFKC, which cannot be
// wiped (04 §2.8 Zeroisation residuals); every byte buffer made here is wiped before returning.
// Errors carry no part of the input (I-7).
import { assertBytes } from './bytes.js';
import { decodeUtf8, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** 04 §2.8 `secretKind`: 1 = generated code, 2 = chosen passphrase. */
export const SECRET_KINDS = Object.freeze({ generatedCode: 1, chosenPassphrase: 2 } as const);
export type SecretKind = (typeof SECRET_KINDS)[keyof typeof SECRET_KINDS];
/** Where the secret was read: a file loses one trailing LF or CRLF; a prompt loses nothing. */
export type SecretSource = 'prompt' | 'file';

/** A generated code: 24 RFC 4648 base32 characters, exactly 120 bits (15 bytes), no padding. */
export const SECRET_CODE_LENGTH = 24;
const CODE_BYTES = 15;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const refused = (): CryptoInputError =>
  new CryptoInputError('invalid_secret', 'secret: not a valid code or passphrase for its kind');

export function assertSecretKind(kind: unknown, what: string): asserts kind is SecretKind {
  if (kind !== 1 && kind !== 2) {
    throw new CryptoInputError('invalid_argument', `${what}: secretKind must be 1 or 2`);
  }
}

/** A copy without one trailing `\n` or `\r\n` for file input; a plain copy for prompt input. */
function stripFileNewline(secret: Uint8Array, source: SecretSource): Uint8Array {
  let end = secret.length;
  if (source === 'file' && end > 0 && secret[end - 1] === 0x0a) {
    end -= end > 1 && secret[end - 2] === 0x0d ? 2 : 1;
  }
  return secret.slice(0, end);
}

/** Base32 value of an upper-case alphabet byte, or -1. */
function base32Value(byte: number): number {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x32 && byte <= 0x37) return byte - 0x32 + 26;
  return -1;
}

function normalizeCode(input: Uint8Array): Uint8Array {
  const chars = new Uint8Array(input.length);
  let n = 0;
  try {
    for (const byte of input) {
      if (byte > 0x7f) throw refused(); // 1. ASCII only
      if (byte === 0x20 || byte === 0x2d) continue; // 2. spaces and dashes
      let c = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte; // 3. ASCII upper case
      if (c === 0x30)
        c = 0x4f; // 4. 0 -> O, 1 -> I, 8 -> B
      else if (c === 0x31) c = 0x49;
      else if (c === 0x38) c = 0x42;
      if (n >= SECRET_CODE_LENGTH) throw refused();
      chars[n] = c;
      n += 1;
    }
    if (n !== SECRET_CODE_LENGTH) throw refused(); // 5. exactly 24 base32 characters
    const out = new Uint8Array(CODE_BYTES); // 6. 24 characters = 120 bits = 15 bytes
    let buffer = 0;
    let bits = 0;
    let o = 0;
    for (let i = 0; i < SECRET_CODE_LENGTH; i += 1) {
      const value = base32Value(chars[i] as number);
      if (value < 0) {
        wipe(out);
        throw refused();
      }
      buffer = ((buffer << 5) | value) & 0xfff;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out[o] = (buffer >> bits) & 0xff;
        o += 1;
      }
    }
    buffer = 0;
    return out;
  } finally {
    wipe(chars);
  }
}

function normalizePassphrase(input: Uint8Array): Uint8Array {
  let text: string;
  try {
    text = decodeUtf8(input); // 1. fatal UTF-8: invalid, overlong and surrogate forms refused
  } catch {
    throw refused();
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) throw refused(); // 2. C0 and C1 controls
  }
  return encodeUtf8(text.normalize('NFKC')); // 3. UTF-8 of NFKC, spaces kept
}

/**
 * 04 §2.8 password(secret, secretKind): the bytes Argon2id gets. A file secret first loses exactly
 * one trailing `\n` or `\r\n`. Kind 1 (generated code): ASCII only; spaces and dashes removed; upper
 * case; 0/1/8 read as O/I/B; exactly 24 base32 characters; the result is their 15 decoded bytes.
 * Kind 2 (chosen passphrase): fatal UTF-8, no C0/C1 control character, then the UTF-8 of NFKC.
 * Refusals (`invalid_secret`) happen here, before any KDF. The input is not modified; wipe the
 * result when done.
 */
export function normalizeSecret(
  secret: Uint8Array,
  secretKind: SecretKind,
  source: SecretSource,
): Uint8Array {
  assertBytes(secret, 'normalizeSecret: secret');
  assertSecretKind(secretKind, 'normalizeSecret');
  if (source !== 'prompt' && source !== 'file') {
    throw new CryptoInputError(
      'invalid_argument',
      'normalizeSecret: source must be prompt or file',
    );
  }
  const input = stripFileNewline(secret, source);
  try {
    return secretKind === 1 ? normalizeCode(input) : normalizePassphrase(input);
  } finally {
    wipe(input);
  }
}

/**
 * A new generated code (04 §2.8, §2.3): 15 CSPRNG bytes as 24 upper-case RFC 4648 base32 ASCII
 * characters, with no bias (120 bits fill exactly 24 characters). Display it in groups of four;
 * wipe it when done.
 */
export function generateSecretCode(): Uint8Array {
  const raw = randomBytes(CODE_BYTES);
  const out = new Uint8Array(SECRET_CODE_LENGTH);
  try {
    let buffer = 0;
    let bits = 0;
    let o = 0;
    for (const byte of raw) {
      buffer = ((buffer << 8) | byte) & 0xfff;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out[o] = BASE32.charCodeAt((buffer >> bits) & 0x1f);
        o += 1;
      }
    }
    return out;
  } finally {
    wipe(raw);
  }
}
