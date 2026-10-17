// 04 §2.8 (D-54): the file KeyStore `ALKS` v1 and the owner seed wrap `ALKO` v1 (04 §2.2, §2.3;
// M1a owner-presence minimum, D-33). Both:
//   kek  = HKDF-SHA256(Argon2id(password(secret, secretKind), salt, m, t, p, 32), "", label, 32)
//   blob = header ‖ AES-256-GCM(kek, nonce, plaintext, AAD = the whole header)
// with label `agentlink/v1/keystore-file` + magic `ALKS`, or `agentlink/v1/owner-passphrase-wrap` +
// magic `ALKO`, so neither ever opens as the other. Everything a reader can check before the KDF is
// checked before it (header values, KDF floor and cap, agent ID, sizes, secret normalisation). Every
// file-level failure is the same `open_failed` error, so a wrong secret and a tampered file are
// indistinguishable. Files and paths are @agentlink/node's job; this module only handles bytes.
import { argon2id, kdfInBounds, KEYSTORE_KDF_DEFAULTS, type Argon2idParams } from './argon2.js';
import { AES_GCM_NONCE_LENGTH, aes256GcmOpen, aes256GcmSeal } from './aes-gcm.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { decodeHex0x, decodeUtf8, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { KEY_LABELS, deriveAgentId, derivePublicKey } from './keys.js';
import { randomBytes } from './random.js';
import {
  assertSecretKind,
  normalizeSecret,
  type SecretKind,
  type SecretSource,
} from './secret-code.js';
import { wipe } from './wipe.js';

export type KeystoreFormat = 'ALKS' | 'ALKO';

const LABELS: Readonly<Record<KeystoreFormat, string>> = Object.freeze({
  ALKS: 'agentlink/v1/keystore-file',
  ALKO: 'agentlink/v1/owner-passphrase-wrap',
});
const MAGIC: Readonly<Record<KeystoreFormat, readonly number[]>> = Object.freeze({
  ALKS: [0x41, 0x4c, 0x4b, 0x53],
  ALKO: [0x41, 0x4c, 0x4b, 0x4f],
});
const VERSION = 1;
const KDF_ARGON2ID = 1;
const AEAD_AES_256_GCM = 1;
const SALT_LENGTH = 16;
const KEK_LENGTH = 32;
const TAG_LENGTH = 16;
/** magic ‖ version ‖ secretKind ‖ kdf ‖ m ‖ t ‖ p ‖ salt ‖ aead ‖ nonce: 42 bytes (ALKO header). */
const COMMON_HEADER_LENGTH = 42;
const OFFSET = Object.freeze({
  kind: 5,
  kdf: 6,
  m: 7,
  t: 11,
  p: 12,
  salt: 13,
  aead: 29,
  nonce: 30,
});
const ALKO_SEED_LENGTH = 32;
const ALKO_LENGTH = COMMON_HEADER_LENGTH + ALKO_SEED_LENGTH + TAG_LENGTH;
const MAX_PLAINTEXT = 65536;
const MAX_ID_LENGTH = 64;
const ID_CHARSET = /^[A-Za-z0-9_-]{1,64}$/;
/** 04 §2.9: the agent ID is exactly `0x` + 40 lowercase hex; checksummed or upper case is refused. */
const AGENT_ID_FORM = /^0x[0-9a-f]{40}$/;

/** A secret and how to read it; the kind comes from the caller on create, from the header on open. */
export interface KeystoreSecret {
  readonly secret: Uint8Array;
  readonly secretKind: SecretKind;
  readonly source: SecretSource;
}
export interface KeystoreUnlockSecret {
  readonly secret: Uint8Array;
  readonly source: SecretSource;
}

/**
 * The derived key-encryption key with the header values it came from (04 §2.8: the server keeps
 * only `kek` and its salt, m, t, p, and checks them on every write). Wipe `kek` when done.
 */
export interface KeystoreKek {
  readonly format: KeystoreFormat;
  readonly secretKind: SecretKind;
  readonly salt: Uint8Array;
  readonly params: Argon2idParams;
  readonly kek: Uint8Array;
}

/** One keychain item: name (the keychain account suffix) and its value as bytes. */
export interface KeystoreEntry {
  readonly name: string;
  readonly value: Uint8Array;
}

/** The owner keys a card names (04 §2.4): ownerEvm (20 bytes) and ownerNostr (32 bytes). */
export interface ExpectedOwner {
  readonly ownerEvm: Uint8Array;
  readonly ownerNostr: Uint8Array;
}

export interface SealOwnerSeedOptions {
  /** Local storage only (owner.alko or a keychain value). Relay publication is refused (04 §2.3). */
  readonly destination: 'local';
  /** On a file-KeyStore machine the owner secret must be a generated code (kind 1, 04 §2.8). */
  readonly fileKeystoreMachine: boolean;
}

const openFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'keystore: cannot open with this secret (wrong secret, or a damaged or foreign file)',
  );

const sameParams = (a: Argon2idParams, b: Argon2idParams): boolean =>
  a.memoryKiB === b.memoryKiB && a.iterations === b.iterations && a.parallelism === b.parallelism;

function assertFormat(format: unknown, what: string): asserts format is KeystoreFormat {
  if (format !== 'ALKS' && format !== 'ALKO') {
    throw new CryptoInputError('invalid_argument', `${what}: format must be ALKS or ALKO`);
  }
}

function assertKdfParams(params: Argon2idParams, what: string): void {
  if (!kdfInBounds(params)) {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: KDF parameters must be within the 04 §2.8 floor and cap`,
    );
  }
}

function assertKek(kek: KeystoreKek, format: KeystoreFormat, what: string): void {
  if (
    typeof kek !== 'object' ||
    kek === null ||
    kek.format !== format ||
    (kek.secretKind !== 1 && kek.secretKind !== 2) ||
    !(kek.salt instanceof Uint8Array) ||
    kek.salt.length !== SALT_LENGTH ||
    !(kek.kek instanceof Uint8Array) ||
    kek.kek.length !== KEK_LENGTH ||
    !kdfInBounds(kek.params)
  ) {
    throw new CryptoInputError('invalid_argument', `${what}: needs a ${format} kek`);
  }
}

function assertAgentId(agentId: unknown, what: string): asserts agentId is string {
  if (typeof agentId !== 'string' || !ID_CHARSET.test(agentId) || !AGENT_ID_FORM.test(agentId)) {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: the agent ID must be 0x + 40 lowercase hex (04 §2.9)`,
    );
  }
}

/**
 * 04 §2.8: the kek for `format` from a secret, a 16-byte salt and in-bounds Argon2id parameters.
 * Refuses an invalid secret (`invalid_secret`) before the KDF runs. Inputs are not modified; the
 * password bytes and the Argon2id output are wiped here.
 */
export async function deriveKeystoreKek(
  format: KeystoreFormat,
  secret: KeystoreSecret,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<KeystoreKek> {
  assertFormat(format, 'deriveKeystoreKek');
  if (typeof secret !== 'object' || secret === null) {
    throw new CryptoInputError('invalid_argument', 'deriveKeystoreKek: secret must be an object');
  }
  assertSecretKind(secret.secretKind, 'deriveKeystoreKek');
  assertBytes(salt, 'deriveKeystoreKek: salt');
  if (salt.length !== SALT_LENGTH) {
    throw new CryptoInputError('invalid_length', 'deriveKeystoreKek: salt must be 16 bytes');
  }
  assertKdfParams(params, 'deriveKeystoreKek');
  const password = normalizeSecret(secret.secret, secret.secretKind, secret.source);
  let stretched: Uint8Array | undefined;
  try {
    stretched = await argon2id(password, salt, params);
    const kek = hkdfSha256(stretched, new Uint8Array(0), encodeUtf8(LABELS[format]), KEK_LENGTH);
    return Object.freeze({
      format,
      secretKind: secret.secretKind,
      salt: salt.slice(),
      params: Object.freeze({
        memoryKiB: params.memoryKiB,
        iterations: params.iterations,
        parallelism: params.parallelism,
      }),
      kek,
    });
  } finally {
    wipe(password, stretched);
  }
}

const MIN_PASSPHRASE_CODE_POINTS = 12;

/** Code points of the normalised password (UTF-8 bytes that are not continuation bytes). */
function codePoints(password: Uint8Array): number {
  let n = 0;
  for (const byte of password) if ((byte & 0xc0) !== 0x80) n += 1;
  return n;
}

/**
 * A kek with a fresh random salt: on create and on every passphrase change (04 §2.8). For `ALKS`, a
 * chosen passphrase (kind 2) needs at least 12 Unicode code points after NFKC
 * (`passphrase_too_short`, 04 §2.8 "Passphrase strength"); checked only here, never on open.
 */
export async function newKeystoreKek(
  format: KeystoreFormat,
  secret: KeystoreSecret,
  params: Argon2idParams = KEYSTORE_KDF_DEFAULTS,
): Promise<KeystoreKek> {
  if (
    format === 'ALKS' &&
    typeof secret === 'object' &&
    secret !== null &&
    secret.secretKind === 2
  ) {
    const password = normalizeSecret(secret.secret, 2, secret.source);
    const length = codePoints(password);
    wipe(password);
    if (length < MIN_PASSPHRASE_CODE_POINTS) {
      throw new CryptoInputError(
        'passphrase_too_short',
        'newKeystoreKek: a chosen passphrase needs at least 12 characters',
      );
    }
  }
  return deriveKeystoreKek(format, secret, randomBytes(SALT_LENGTH), params);
}

function commonHeader(format: KeystoreFormat, kek: KeystoreKek, nonce: Uint8Array): Uint8Array {
  const h = new Uint8Array(COMMON_HEADER_LENGTH);
  h.set(MAGIC[format], 0);
  h[4] = VERSION;
  h[OFFSET.kind] = kek.secretKind;
  h[OFFSET.kdf] = KDF_ARGON2ID;
  new DataView(h.buffer).setUint32(OFFSET.m, kek.params.memoryKiB, false);
  h[OFFSET.t] = kek.params.iterations;
  h[OFFSET.p] = kek.params.parallelism;
  h.set(kek.salt, OFFSET.salt);
  h[OFFSET.aead] = AEAD_AES_256_GCM;
  h.set(nonce, OFFSET.nonce);
  return h;
}

interface ParsedHeader {
  readonly secretKind: SecretKind;
  readonly params: Argon2idParams;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly length: number;
}

/** The checks both formats share; `undefined` when the header is not a valid v1 header. */
function parseCommonHeader(format: KeystoreFormat, file: Uint8Array): ParsedHeader | undefined {
  if (file.length < COMMON_HEADER_LENGTH + TAG_LENGTH) return undefined;
  if (!MAGIC[format].every((byte, i) => file[i] === byte)) return undefined;
  if (file[4] !== VERSION || file[OFFSET.kdf] !== KDF_ARGON2ID) return undefined;
  if (file[OFFSET.aead] !== AEAD_AES_256_GCM) return undefined;
  const kind = file[OFFSET.kind];
  if (kind !== 1 && kind !== 2) return undefined;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const params = Object.freeze({
    memoryKiB: view.getUint32(OFFSET.m, false),
    iterations: file[OFFSET.t] as number,
    parallelism: file[OFFSET.p] as number,
  });
  if (!kdfInBounds(params)) return undefined;
  return {
    secretKind: kind,
    params,
    salt: file.slice(OFFSET.salt, OFFSET.salt + SALT_LENGTH),
    nonce: file.slice(OFFSET.nonce, OFFSET.nonce + AES_GCM_NONCE_LENGTH),
    length: COMMON_HEADER_LENGTH,
  };
}

/** ALKS header checks, all before the KDF: format, bounds, idLen, charset, exact form, expected ID. */
function parseAlksHeader(file: Uint8Array, expectedAgentId: string): ParsedHeader {
  const common = parseCommonHeader('ALKS', file);
  if (common === undefined) throw openFailed();
  const idLen = file[COMMON_HEADER_LENGTH] as number;
  const length = COMMON_HEADER_LENGTH + 1 + idLen;
  if (idLen < 1 || idLen > MAX_ID_LENGTH || file.length < length + TAG_LENGTH) throw openFailed();
  if (file.length - length - TAG_LENGTH > MAX_PLAINTEXT) throw openFailed();
  let agentId = '';
  for (const byte of file.subarray(COMMON_HEADER_LENGTH + 1, length)) {
    agentId += String.fromCharCode(byte);
  }
  if (!ID_CHARSET.test(agentId) || !AGENT_ID_FORM.test(agentId) || agentId !== expectedAgentId) {
    throw openFailed();
  }
  return { ...common, length };
}

function encodeEntries(entries: readonly KeystoreEntry[], what: string): Uint8Array {
  if (!Array.isArray(entries)) {
    throw new CryptoInputError('invalid_argument', `${what}: entries must be an array`);
  }
  const parts: Uint8Array[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries as readonly unknown[]) {
    const e = entry as Partial<KeystoreEntry> | null;
    if (typeof e?.name !== 'string' || !(e.value instanceof Uint8Array)) {
      throw new CryptoInputError('invalid_argument', `${what}: each entry needs a name and bytes`);
    }
    if (names.has(e.name)) {
      throw new CryptoInputError('invalid_argument', `${what}: entry names must be unique`);
    }
    names.add(e.name);
    const name = encodeUtf8(e.name);
    total += 2 + name.length + 4 + e.value.length;
    if (name.length > 0xffff || total > MAX_PLAINTEXT) {
      throw new CryptoInputError('invalid_argument', `${what}: entries exceed 64 KiB`);
    }
    const head = new Uint8Array(2 + name.length + 4);
    const view = new DataView(head.buffer);
    view.setUint16(0, name.length, false);
    head.set(name, 2);
    view.setUint32(2 + name.length, e.value.length, false);
    parts.push(head, e.value);
  }
  return concatBytes(...parts);
}

/** 04 §2.8 entry list; `undefined` on any refusal (overflow, trailing bytes, bad UTF-8, duplicate). */
function decodeEntries(plaintext: Uint8Array): KeystoreEntry[] | undefined {
  if (plaintext.length > MAX_PLAINTEXT) return undefined;
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const entries: KeystoreEntry[] = [];
  const fail = (): undefined => {
    wipe(...entries.map((e) => e.value));
    return undefined;
  };
  let i = 0;
  while (i < plaintext.length) {
    if (i + 2 > plaintext.length) return fail();
    const nameLength = view.getUint16(i, false);
    i += 2;
    if (i + nameLength + 4 > plaintext.length) return fail();
    let name: string;
    try {
      name = decodeUtf8(plaintext.subarray(i, i + nameLength));
    } catch {
      return fail();
    }
    i += nameLength;
    const size = view.getUint32(i, false);
    i += 4;
    if (i + size > plaintext.length) return fail();
    if (entries.some((e) => e.name === name)) return fail();
    entries.push(Object.freeze({ name, value: plaintext.slice(i, i + size) }));
    i += size;
  }
  return entries;
}

/** The `seed` entry must derive `agentId`, compared as bytes (04 §2.8, §2.9). */
function seedDerives(entries: readonly KeystoreEntry[], agentId: string): boolean {
  const seeds = entries.filter((e) => e.name === 'seed');
  if (seeds.length !== 1) return false;
  try {
    const derived = decodeHex0x(deriveAgentId((seeds[0] as KeystoreEntry).value), { length: 20 });
    return equalBytes(derived, decodeHex0x(agentId, { length: 20 }));
  } catch {
    return false;
  }
}

/** Seals with the given nonce. Only sealKeystoreFile (fresh nonce) and the test seam call it. */
export async function sealKeystoreFileWithNonceUnsafe(
  kek: KeystoreKek,
  nonce: Uint8Array,
  agentId: string,
  entries: readonly KeystoreEntry[],
): Promise<Uint8Array> {
  assertKek(kek, 'ALKS', 'sealKeystoreFile');
  assertBytes(nonce, 'sealKeystoreFile: nonce');
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError('invalid_length', 'sealKeystoreFile: nonce must be 12 bytes');
  }
  assertAgentId(agentId, 'sealKeystoreFile');
  const plaintext = encodeEntries(entries, 'sealKeystoreFile');
  if (!seedDerives(entries, agentId)) {
    wipe(plaintext);
    throw new CryptoInputError(
      'invalid_argument',
      'sealKeystoreFile: entries need one seed that derives the agent ID',
    );
  }
  const header = concatBytes(
    commonHeader('ALKS', kek, nonce),
    Uint8Array.of(agentId.length),
    encodeUtf8(agentId),
  );
  try {
    return concatBytes(header, await aes256GcmSeal(kek.kek, nonce, plaintext, header));
  } finally {
    wipe(plaintext);
  }
}

/**
 * 04 §2.8: an `ALKS` v1 file for `agentId` (0x + 40 lowercase hex) holding `entries`, under `kek`
 * (format ALKS) with a fresh random nonce. The entries need exactly one `seed` that derives the
 * agent ID; names are unique; the plaintext is at most 64 KiB. Inputs are not modified.
 */
export function sealKeystoreFile(
  kek: KeystoreKek,
  agentId: string,
  entries: readonly KeystoreEntry[],
): Promise<Uint8Array> {
  return sealKeystoreFileWithNonceUnsafe(kek, randomBytes(AES_GCM_NONCE_LENGTH), agentId, entries);
}

async function decryptAlks(
  file: Uint8Array,
  header: ParsedHeader,
  kek: KeystoreKek,
  expectedAgentId: string,
): Promise<readonly KeystoreEntry[]> {
  const aad = file.subarray(0, header.length);
  const plaintext = await aes256GcmOpen(kek.kek, header.nonce, file.subarray(header.length), aad);
  if (plaintext === undefined) throw openFailed();
  try {
    const entries = decodeEntries(plaintext);
    if (entries === undefined) throw openFailed();
    if (!seedDerives(entries, expectedAgentId)) {
      wipe(...entries.map((e) => e.value));
      throw openFailed();
    }
    return Object.freeze(entries);
  } finally {
    wipe(plaintext);
  }
}

/**
 * 04 §2.8: opens an `ALKS` v1 file for the agent `expectedAgentId` (refused unless it is exactly
 * 0x + 40 lowercase hex, before anything else). Header values, KDF bounds, sizes and the header agent
 * ID are checked before the KDF; then the secret is normalised by the header's kind, the kek derived,
 * the file authenticated and parsed, and the `seed` entry must derive the agent ID. Returns the
 * entries (values as bytes, wipe them when done) and the kek for later writes. Every file-level
 * failure is `open_failed`.
 */
export async function openKeystoreFile(
  file: Uint8Array,
  secret: KeystoreUnlockSecret,
  expectedAgentId: string,
): Promise<{ readonly entries: readonly KeystoreEntry[]; readonly kek: KeystoreKek }> {
  assertBytes(file, 'openKeystoreFile: file');
  assertAgentId(expectedAgentId, 'openKeystoreFile');
  if (typeof secret !== 'object' || secret === null) {
    throw new CryptoInputError('invalid_argument', 'openKeystoreFile: secret must be an object');
  }
  const header = parseAlksHeader(file, expectedAgentId);
  const kek = await deriveKeystoreKek(
    'ALKS',
    { secret: secret.secret, secretKind: header.secretKind, source: secret.source },
    header.salt,
    header.params,
  );
  try {
    return Object.freeze({ entries: await decryptAlks(file, header, kek, expectedAgentId), kek });
  } catch (error) {
    wipe(kek.kek);
    throw error;
  }
}

/**
 * 04 §2.8 write protocol, steps 1–3: opens a re-read `ALKS` file with the in-memory kek. Refused
 * (`open_failed`) when the header's salt, m, t, p or secretKind differ from those behind the kek, so
 * a server holding a stale kek can neither revert a passphrase change nor drop another writer's items.
 */
export async function openKeystoreFileWithKek(
  file: Uint8Array,
  kek: KeystoreKek,
  expectedAgentId: string,
): Promise<readonly KeystoreEntry[]> {
  assertBytes(file, 'openKeystoreFileWithKek: file');
  assertKek(kek, 'ALKS', 'openKeystoreFileWithKek');
  assertAgentId(expectedAgentId, 'openKeystoreFileWithKek');
  const header = parseAlksHeader(file, expectedAgentId);
  if (
    header.secretKind !== kek.secretKind ||
    !equalBytes(header.salt, kek.salt) ||
    !sameParams(header.params, kek.params)
  ) {
    throw openFailed();
  }
  return decryptAlks(file, header, kek, expectedAgentId);
}

function assertOwnerOptions(
  options: SealOwnerSeedOptions,
  kek: KeystoreKek | undefined,
  what: string,
): void {
  if (typeof options !== 'object' || options === null) {
    throw new CryptoInputError('invalid_argument', `${what}: options are required`);
  }
  if ((options.destination as string) === 'relay') {
    throw new CryptoInputError(
      'relay_publication_refused',
      `${what}: an owner passphrase or code wrap is for local storage only, never for relays`,
    );
  }
  if (options.destination !== 'local' || typeof options.fileKeystoreMachine !== 'boolean') {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: destination must be local and fileKeystoreMachine a boolean`,
    );
  }
  if (kek !== undefined && options.fileKeystoreMachine && kek.secretKind !== 1) {
    throw new CryptoInputError(
      'secret_kind_refused',
      `${what}: a file-KeyStore machine needs a generated owner code`,
    );
  }
}

/** Seals with the given nonce. Only sealOwnerSeed (fresh nonce) and the test seam call it. */
export async function sealOwnerSeedWithNonceUnsafe(
  kek: KeystoreKek,
  nonce: Uint8Array,
  seed: Uint8Array,
  options: SealOwnerSeedOptions,
): Promise<Uint8Array> {
  assertOwnerOptions(options, undefined, 'sealOwnerSeed');
  assertKek(kek, 'ALKO', 'sealOwnerSeed');
  assertOwnerOptions(options, kek, 'sealOwnerSeed');
  assertBytes(nonce, 'sealOwnerSeed: nonce');
  assertBytes(seed, 'sealOwnerSeed: seed');
  if (nonce.length !== AES_GCM_NONCE_LENGTH || seed.length !== ALKO_SEED_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'sealOwnerSeed: the nonce must be 12 bytes and the seed 32 bytes',
    );
  }
  const header = commonHeader('ALKO', kek, nonce);
  return concatBytes(header, await aes256GcmSeal(kek.kek, nonce, seed, header));
}

/**
 * 04 §2.8 `ALKO` v1: the 32-byte owner seed under `kek` (format ALKO), with a fresh random nonce,
 * for local storage only (`owner.alko` or a keychain value). A relay destination is refused
 * (`relay_publication_refused`, 04 §2.3); on a file-KeyStore machine a chosen passphrase (kind 2) is
 * refused (`secret_kind_refused`). The blob is exactly 90 bytes.
 */
export function sealOwnerSeed(
  kek: KeystoreKek,
  seed: Uint8Array,
  options: SealOwnerSeedOptions,
): Promise<Uint8Array> {
  return sealOwnerSeedWithNonceUnsafe(kek, randomBytes(AES_GCM_NONCE_LENGTH), seed, options);
}

/**
 * Module-private marker for openOwnerSeedWithoutCard: no card names the owner, so there is no
 * expected owner to compare with. Never reachable through a caller's `expected` argument.
 */
const WITHOUT_CARD: unique symbol = Symbol('openOwnerSeed.withoutCard');

/** openOwnerSeed without the prompt-only rule (shared with ownerSecretUnlocks). */
async function openOwnerSeedFrom(
  blob: Uint8Array,
  secret: KeystoreUnlockSecret,
  expected: ExpectedOwner | typeof WITHOUT_CARD,
  options: { readonly fileKeystoreMachine: boolean },
): Promise<Uint8Array> {
  assertBytes(blob, 'openOwnerSeed: blob');
  if (typeof secret !== 'object' || secret === null) {
    throw new CryptoInputError('invalid_argument', 'openOwnerSeed: secret must be an object');
  }
  if (
    expected !== WITHOUT_CARD &&
    (typeof expected !== 'object' ||
      expected === null ||
      !(expected.ownerEvm instanceof Uint8Array) ||
      expected.ownerEvm.length !== 20 ||
      !(expected.ownerNostr instanceof Uint8Array) ||
      expected.ownerNostr.length !== 32)
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      'openOwnerSeed: expected owner keys must be 20 and 32 bytes',
    );
  }
  if (typeof options !== 'object' || options === null) {
    throw new CryptoInputError('invalid_argument', 'openOwnerSeed: options are required');
  }
  if (typeof options.fileKeystoreMachine !== 'boolean') {
    throw new CryptoInputError(
      'invalid_argument',
      'openOwnerSeed: fileKeystoreMachine must be a boolean',
    );
  }
  if (blob.length !== ALKO_LENGTH) throw openFailed();
  const header = parseCommonHeader('ALKO', blob);
  if (header === undefined) throw openFailed();
  if (options.fileKeystoreMachine && header.secretKind !== 1) {
    throw new CryptoInputError(
      'secret_kind_refused',
      'openOwnerSeed: a file-KeyStore machine needs a generated owner code',
    );
  }
  const kek = await deriveKeystoreKek(
    'ALKO',
    { secret: secret.secret, secretKind: header.secretKind, source: secret.source },
    header.salt,
    header.params,
  );
  let seed: Uint8Array | undefined;
  try {
    const aad = blob.subarray(0, COMMON_HEADER_LENGTH);
    seed = await aes256GcmOpen(kek.kek, header.nonce, blob.subarray(COMMON_HEADER_LENGTH), aad);
    if (seed === undefined || seed.length !== ALKO_SEED_LENGTH) throw openFailed();
    if (expected === WITHOUT_CARD) {
      const out = seed;
      seed = undefined;
      return out;
    }
    const evm = derivePublicKey(seed, KEY_LABELS.evm, 0);
    const nostr = derivePublicKey(seed, KEY_LABELS.nostr, 0);
    if (
      evm.label !== KEY_LABELS.evm ||
      nostr.label !== KEY_LABELS.nostr ||
      !equalBytes(evm.address, expected.ownerEvm) ||
      !equalBytes(nostr.publicKey, expected.ownerNostr)
    ) {
      throw openFailed();
    }
    const out = seed;
    seed = undefined;
    return out;
  } finally {
    wipe(kek.kek, seed);
  }
}

/**
 * 04 §2.8: the owner secret only from a prompt (D-54). Refused before the KDF: any size other than
 * 90 bytes, a header that is not ALKO v1, KDF parameters out of bounds (`open_failed`), and kind 2 on
 * a file-KeyStore machine (`secret_kind_refused`). After decryption the seed must derive the card's
 * `ownerEvm` and `ownerNostr` (04 §2.1, epoch 0), compared as bytes; otherwise it is wiped and
 * refused. Wipe the returned seed when done.
 */
export function openOwnerSeed(
  blob: Uint8Array,
  secret: KeystoreUnlockSecret,
  expected: ExpectedOwner,
  options: { readonly fileKeystoreMachine: boolean },
): Promise<Uint8Array> {
  // D-54, 04 §2.8: the owner secret comes only from an interactive prompt, never from a file. (The
  // agent ≠ owner probe below may test an agent secret read from a file.)
  if (typeof secret !== 'object' || secret === null || secret.source !== 'prompt') {
    return Promise.reject(
      new CryptoInputError(
        'invalid_argument',
        'openOwnerSeed: the owner secret comes from a prompt',
      ),
    );
  }
  return openOwnerSeedFrom(blob, secret, expected, options);
}

/**
 * M1-9x (04 §2.8 "Adding an agent to the existing owner"): openOwnerSeed when no local agent card
 * names the owner, so there is no expected owner to compare with (for example after every carded
 * agent was removed). The caller derives the owner keys from the returned seed and has the owner
 * confirm the owner fingerprint before anything is signed. Every other rule of openOwnerSeed holds:
 * the secret only from a prompt, the same refusals before the KDF, and one generic `open_failed` for
 * a wrong secret or a damaged blob. Wipe the returned seed when done.
 */
export function openOwnerSeedWithoutCard(
  blob: Uint8Array,
  secret: KeystoreUnlockSecret,
  options: { readonly fileKeystoreMachine: boolean },
): Promise<Uint8Array> {
  if (typeof secret !== 'object' || secret === null || secret.source !== 'prompt') {
    return Promise.reject(
      new CryptoInputError(
        'invalid_argument',
        'openOwnerSeed: the owner secret comes from a prompt',
      ),
    );
  }
  return openOwnerSeedFrom(blob, secret, WITHOUT_CARD, options);
}

/**
 * 04 §2.8 "agent and owner secrets always differ": does `candidate` unlock this owner wrap? The
 * candidate is normalised the way the blob's kind requires; one that fails that normalisation, or
 * any other refusal, "does not unlock" (false), never an error. A seed the check unwraps is wiped at
 * once and never returned.
 */
export async function ownerSecretUnlocks(
  blob: Uint8Array,
  candidate: KeystoreUnlockSecret,
  expected: ExpectedOwner,
): Promise<boolean> {
  try {
    const seed = await openOwnerSeedFrom(blob, candidate, expected, { fileKeystoreMachine: false });
    wipe(seed);
    return true;
  } catch (error) {
    if (error instanceof CryptoInputError) return false;
    throw error;
  }
}

/**
 * 04 §2.8, the other direction: does `candidate` open this agent's `ALKS` file? Same rules as
 * ownerSecretUnlocks: refusals are false, and every unwrapped entry and the kek are wiped at once.
 */
export async function keystoreSecretUnlocks(
  file: Uint8Array,
  candidate: KeystoreUnlockSecret,
  expectedAgentId: string,
): Promise<boolean> {
  try {
    const opened = await openKeystoreFile(file, candidate, expectedAgentId);
    wipe(opened.kek.kek, ...opened.entries.map((e) => e.value));
    return true;
  } catch (error) {
    if (error instanceof CryptoInputError) return false;
    throw error;
  }
}
