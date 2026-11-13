// D-145 (5), 08 §8 (WP-D10): the desktop update key file `ALKU` v1, for the owner's OFFLINE signing
// tool (tools/desktop/sign-manifest.mjs) only. It seals one 32-byte BIP-340 secret key (the root or
// the update key) under a chosen passphrase, like `ALKO` (04 §2.8) but with its own magic, its own
// KDF label and the key ROLE in the header, so the whole header (role included) is the AAD:
//
//   kek  = HKDF-SHA256(Argon2id(password(passphrase, kind 2), salt, m, t, p, 32), "",
//                      "agentlink/v1/desktop-update-key", 32)
//   file = "ALKU" ‖ 0x01 ‖ role (1 root, 2 update) ‖ m (u32 BE) ‖ t ‖ p ‖ salt (16) ‖ nonce (12)
//          ‖ AES-256-GCM(kek, nonce, secretKey, AAD = those 39 header bytes)       (87 bytes)
//
// An ALKU file never opens as ALKO or ALKS (different label and magic), a root file never opens as
// an update file (role checked before the KDF and bound by the AAD), and every file-level failure is
// one `open_failed`. The passphrase comes only from a prompt. Exported only from /keystore.
import { argon2id, kdfInBounds, type Argon2idParams } from './argon2.js';
import { AES_GCM_NONCE_LENGTH, aes256GcmOpen, aes256GcmSeal } from './aes-gcm.js';
import { assertBytes, concatBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { randomBytes } from './random.js';
import { normalizeSecret } from './secret-code.js';
import { wipe } from './wipe.js';

export type UpdateKeyRole = 'root' | 'update';

const MAGIC = [0x41, 0x4c, 0x4b, 0x55]; // "ALKU"
const VERSION = 1;
const LABEL = 'agentlink/v1/desktop-update-key';
const ROLE_BYTE: Readonly<Record<UpdateKeyRole, number>> = Object.freeze({ root: 1, update: 2 });
const SALT_LENGTH = 16;
const SECRET_LENGTH = 32;
const TAG_LENGTH = 16;
/** magic ‖ version ‖ role ‖ m ‖ t ‖ p ‖ salt ‖ nonce. */
export const UPDATE_KEY_FILE_HEADER_LENGTH = 4 + 1 + 1 + 4 + 1 + 1 + SALT_LENGTH + 12;
export const UPDATE_KEY_FILE_LENGTH = UPDATE_KEY_FILE_HEADER_LENGTH + SECRET_LENGTH + TAG_LENGTH;
const MIN_PASSPHRASE_CODE_POINTS = 16;

const openFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'update key file: cannot open with this passphrase (wrong passphrase, wrong role, or a damaged or foreign file)',
  );

function assertRole(role: unknown, what: string): asserts role is UpdateKeyRole {
  if (role !== 'root' && role !== 'update') {
    throw new CryptoInputError('invalid_argument', `${what}: role must be root or update`);
  }
}

async function kek(
  passphrase: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  const password = normalizeSecret(passphrase, 2, 'prompt');
  let stretched: Uint8Array | undefined;
  try {
    stretched = await argon2id(password, salt, params);
    return hkdfSha256(stretched, new Uint8Array(0), encodeUtf8(LABEL), 32);
  } finally {
    wipe(password, stretched);
  }
}

function header(role: UpdateKeyRole, params: Argon2idParams, salt: Uint8Array, nonce: Uint8Array) {
  const h = new Uint8Array(UPDATE_KEY_FILE_HEADER_LENGTH);
  h.set(MAGIC, 0);
  h[4] = VERSION;
  h[5] = ROLE_BYTE[role];
  new DataView(h.buffer).setUint32(6, params.memoryKiB, false);
  h[10] = params.iterations;
  h[11] = params.parallelism;
  h.set(salt, 12);
  h.set(nonce, 12 + SALT_LENGTH);
  return h;
}

/**
 * Seals a 32-byte secret key for `role` under a chosen passphrase (at least 16 characters after
 * NFKC, `passphrase_too_short`) with in-bounds Argon2id parameters. Inputs are not modified.
 */
export async function sealUpdateKeyFile(
  role: UpdateKeyRole,
  secretKey: Uint8Array,
  passphrase: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  assertRole(role, 'sealUpdateKeyFile');
  assertBytes(secretKey, 'sealUpdateKeyFile: secretKey');
  assertBytes(passphrase, 'sealUpdateKeyFile: passphrase');
  if (secretKey.length !== SECRET_LENGTH) {
    throw new CryptoInputError('invalid_length', 'sealUpdateKeyFile: the key must be 32 bytes');
  }
  if (!kdfInBounds(params)) {
    throw new CryptoInputError(
      'invalid_argument',
      'sealUpdateKeyFile: KDF parameters out of bounds',
    );
  }
  const normalized = normalizeSecret(passphrase, 2, 'prompt');
  let length = 0; // code points: UTF-8 bytes that are not continuation bytes
  for (const byte of normalized) if ((byte & 0xc0) !== 0x80) length += 1;
  wipe(normalized);
  if (length < MIN_PASSPHRASE_CODE_POINTS) {
    throw new CryptoInputError(
      'passphrase_too_short',
      'sealUpdateKeyFile: the passphrase needs at least 16 characters',
    );
  }
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
  const h = header(role, params, salt, nonce);
  const key = await kek(passphrase, salt, params);
  try {
    return concatBytes(h, await aes256GcmSeal(key, nonce, secretKey, h));
  } finally {
    wipe(key);
  }
}

/**
 * Opens an `ALKU` v1 file that must hold the `role` key. Size, magic, version, role and KDF bounds
 * are checked before the KDF. Returns the 32-byte secret key; wipe it when done.
 */
export async function openUpdateKeyFile(
  file: Uint8Array,
  role: UpdateKeyRole,
  passphrase: Uint8Array,
): Promise<Uint8Array> {
  assertBytes(file, 'openUpdateKeyFile: file');
  assertRole(role, 'openUpdateKeyFile');
  assertBytes(passphrase, 'openUpdateKeyFile: passphrase');
  if (file.length !== UPDATE_KEY_FILE_LENGTH) throw openFailed();
  if (!MAGIC.every((b, i) => file[i] === b) || file[4] !== VERSION) throw openFailed();
  if (file[5] !== ROLE_BYTE[role]) throw openFailed();
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const params = {
    memoryKiB: view.getUint32(6, false),
    iterations: file[10] as number,
    parallelism: file[11] as number,
  };
  if (!kdfInBounds(params)) throw openFailed();
  const salt = file.slice(12, 12 + SALT_LENGTH);
  const nonce = file.slice(12 + SALT_LENGTH, UPDATE_KEY_FILE_HEADER_LENGTH);
  const h = file.subarray(0, UPDATE_KEY_FILE_HEADER_LENGTH);
  const key = await kek(passphrase, salt, params);
  try {
    const secret = await aes256GcmOpen(key, nonce, file.subarray(UPDATE_KEY_FILE_HEADER_LENGTH), h);
    if (secret === undefined || secret.length !== SECRET_LENGTH) throw openFailed();
    return secret;
  } finally {
    wipe(key);
  }
}

/** The role a file claims (public header byte), read before any passphrase is asked. */
export function readUpdateKeyFileRole(file: Uint8Array): UpdateKeyRole | undefined {
  if (!(file instanceof Uint8Array) || file.length !== UPDATE_KEY_FILE_LENGTH) return undefined;
  if (!MAGIC.every((b, i) => file[i] === b) || file[4] !== VERSION) return undefined;
  return file[5] === 1 ? 'root' : file[5] === 2 ? 'update' : undefined;
}
