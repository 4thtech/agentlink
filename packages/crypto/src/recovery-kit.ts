// 04 §2.3.3 (D-115): the recovery kit `ALKK` v1, written by `agentlink backup export` and read by
// `agentlink backup restore` (M1-9i-b).
//   header (74 B) = "ALKK" ‖ u8 version=1 ‖ u8 secretKind=1 ‖ u8 kdf=1 ‖ u32be m ‖ u8 t ‖ u8 p
//                   ‖ salt (16) ‖ u8 aead=2 ‖ u32be chunkSize ‖ noncePrefix (8) ‖ ownerNostr (32)
//   kek  = HKDF-SHA256(Argon2id(password(code, 1), salt, m, t, p, 32), "", "agentlink/v1/recovery-kit", 32)
//   body = the 04 §4 STREAM construction of stream.ts under kek, with the 74-byte header as the AAD
//          prefix of every chunk and the ALF1 chunk rules.
//   plaintext = entries `u16be nameLen ‖ name ‖ u64be valueLen ‖ value`: `manifest` (JCS), then
//          `owner/seed`, then per agent in manifest order its items (seed, store-key,
//          policy-version, receipts-kept, storage-mark; the first two required) and its store.
//
// Reading: every header refusal happens before the KDF. While the body decrypts, each chunk's
// plaintext is framed only far enough to route it (entry boundaries, the caps): secret entries go to
// in-memory buffers, store values to a caller-provided sink (the restore's quarantined temporary
// file). Nothing is parsed, checked or returned before the final chunk authenticates; then the entry
// list, the manifest and the seeds are checked. Every failure is one `open_failed` error: all buffers
// are wiped and every sink is discarded. The manifest, the owner seed and the items stay in
// Uint8Array buffers and never become JS strings here (04 §2.3.3 "Secret entries never touch disk").
// The store snapshot is opaque bytes: its `identity.agent_id` and card checks are the restore's
// (M1-9i-c), which can read SQLite.
//
// Argon2id and HKDF are @noble/hashes through argon2.ts and hkdf.ts, AES-256-GCM is WebCrypto through
// stream.ts; nothing here implements a primitive (I-8). Errors never contain input (I-7).
import { argon2id, kdfInBounds, KEYSTORE_KDF_DEFAULTS, type Argon2idParams } from './argon2.js';
import { assertBytes, equalBytes } from './bytes.js';
import { decodeBase64url, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { canonicalizeToBytes } from './jcs.js';
import { KEY_LABELS, deriveAgentId, derivePublicKey } from './keys.js';
import { generateRecoveryCode, type RecoveryCodeSecret } from './owner-seed-wrap.js';
import { randomBytes } from './random.js';
import { normalizeSecret } from './secret-code.js';
import {
  ALF1_MAX_CHUNK_SIZE,
  ALF1_TAG_LENGTH,
  createStreamOpenerAt,
  createStreamSealerAt,
  isStreamChunkSize,
  streamKeyOf,
  type Alf1Processor,
  type StreamFormat,
} from './stream.js';
import { wipe } from './wipe.js';

export const RECOVERY_KIT_HEADER_LENGTH = 74;
/** What writers use (04 §2.3.3); readers accept 1 B to 16 MiB. */
export const RECOVERY_KIT_DEFAULT_CHUNK_SIZE = 1_048_576;
export const RECOVERY_KIT_MAX_CHUNK_SIZE = ALF1_MAX_CHUNK_SIZE;
/** 04 §2.3.3 caps. The store cap is marked proposed in the spec. */
export const RECOVERY_KIT_LIMITS = Object.freeze({
  maxAgents: 16,
  maxItemBytes: 65_536,
  maxStoreBytes: 1_073_741_824,
  maxKitBytes: 4_294_967_296,
});
/**
 * The KeyStore items a kit carries per agent, in kit order (04 §2.3.3; never `s3:*`, D-115 D).
 * W4-RENAME-REACHES-CONTACTS (D-141): `key-epoch`, optional and last, so a restored agent that was
 * renamed (rotated) opens at its epoch; a kit without it (every earlier kit) reads as epoch 0.
 */
export const RECOVERY_KIT_ITEM_NAMES = Object.freeze([
  'seed',
  'store-key',
  'policy-version',
  'receipts-kept',
  'storage-mark',
  'key-epoch',
] as const);
export type RecoveryKitItemName = (typeof RECOVERY_KIT_ITEM_NAMES)[number];
export type RecoveryKitContents = 'full' | 'identity';

const INFO = 'agentlink/v1/recovery-kit';
const MAGIC = Object.freeze([0x41, 0x4c, 0x4b, 0x4b]); // "ALKK"
const VERSION = 1;
const SECRET_KIND_CODE = 1;
const KDF_ARGON2ID = 1;
const AEAD_STREAM = 2;
const SEED_LENGTH = 32;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_PREFIX_LENGTH = 8;
const OWNER_LENGTH = 32;
const H = Object.freeze({
  kind: 5,
  kdf: 6,
  m: 7,
  t: 11,
  p: 12,
  salt: 13,
  aead: 29,
  chunkSize: 30,
  prefix: 34,
  owner: 42,
});
const REQUIRED_ITEMS = 2; // seed and store-key, the first two names
const ENTRY_HEAD = 2 + 8; // u16be nameLen + u64be valueLen, around the name
const MAX_SAFE_HIGH = 0x1fffff; // a u64 high word above this is beyond 2^53 - 1

const openFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'recovery kit: cannot open (wrong code, another owner, or a damaged, truncated or foreign kit)',
  );
const argument = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_argument', `recovery kit: ${message}`);

// --- header ---------------------------------------------------------------------------------------

interface HeaderFields {
  readonly params: Argon2idParams;
  readonly salt: Uint8Array;
  readonly chunkSize: number;
  readonly noncePrefix: Uint8Array;
  readonly ownerNostr: Uint8Array;
}

/** Every header check that needs no key (04 §2.3.3); `undefined` when any fails. Views, no copies. */
function parseHeader(bytes: Uint8Array): HeaderFields | undefined {
  if (bytes.length < RECOVERY_KIT_HEADER_LENGTH) return undefined;
  if (MAGIC.some((byte, i) => bytes[i] !== byte)) return undefined;
  if (
    bytes[4] !== VERSION ||
    bytes[H.kind] !== SECRET_KIND_CODE ||
    bytes[H.kdf] !== KDF_ARGON2ID ||
    bytes[H.aead] !== AEAD_STREAM
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const params = {
    memoryKiB: view.getUint32(H.m, false),
    iterations: bytes[H.t] as number,
    parallelism: bytes[H.p] as number,
  };
  const chunkSize = view.getUint32(H.chunkSize, false);
  if (!kdfInBounds(params) || !isStreamChunkSize(chunkSize)) return undefined;
  return {
    params,
    salt: bytes.subarray(H.salt, H.salt + SALT_LENGTH),
    chunkSize,
    noncePrefix: bytes.subarray(H.prefix, H.prefix + NONCE_PREFIX_LENGTH),
    ownerNostr: bytes.subarray(H.owner, H.owner + OWNER_LENGTH),
  };
}

const ALKK_FORMAT: StreamFormat = Object.freeze({
  name: 'alkk',
  headerLength: RECOVERY_KIT_HEADER_LENGTH,
  readHeader(header: Uint8Array) {
    const fields = parseHeader(header);
    return fields === undefined
      ? undefined
      : { chunkSize: fields.chunkSize, noncePrefix: fields.noncePrefix };
  },
});

function encodeHeader(
  params: Argon2idParams,
  salt: Uint8Array,
  chunkSize: number,
  noncePrefix: Uint8Array,
  ownerNostr: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(RECOVERY_KIT_HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[H.kind] = SECRET_KIND_CODE;
  header[H.kdf] = KDF_ARGON2ID;
  view.setUint32(H.m, params.memoryKiB, false);
  header[H.t] = params.iterations;
  header[H.p] = params.parallelism;
  header.set(salt, H.salt);
  header[H.aead] = AEAD_STREAM;
  view.setUint32(H.chunkSize, chunkSize, false);
  header.set(noncePrefix, H.prefix);
  header.set(ownerNostr, H.owner);
  return header;
}

/** The public header of a kit, shown before the code is asked for (04 §2.3.3 restore step 1). */
export interface RecoveryKitHeader {
  /** 32-byte x-only owner Nostr key: restore shows its fingerprint and refuses another owner. */
  readonly ownerNostr: Uint8Array;
  readonly chunkSize: number;
  readonly kdf: Argon2idParams;
}

/**
 * 04 §2.3.3 restore step 1: the public header of an ALKK v1 kit, from at least its first 74 bytes.
 * Refuses (`open_failed`), before any KDF, a wrong magic, `version` ≠ 1, `secretKind` ≠ 1,
 * `kdf` ≠ 1, `aead` ≠ 2, a `chunkSize` outside 1 B..16 MiB and KDF parameters outside the 04 §2.8
 * floor and cap. Nothing here is secret.
 */
export function readRecoveryKitHeader(kit: Uint8Array): RecoveryKitHeader {
  assertBytes(kit, 'readRecoveryKitHeader: kit');
  const fields = parseHeader(kit);
  if (fields === undefined) throw openFailed();
  return Object.freeze({
    ownerNostr: fields.ownerNostr.slice(),
    chunkSize: fields.chunkSize,
    kdf: Object.freeze({ ...fields.params }),
  });
}

async function kitKek(
  secret: RecoveryCodeSecret,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  // password() kind 1 refuses a malformed code (`invalid_secret`) before the KDF runs.
  const password = normalizeSecret(secret.secret, SECRET_KIND_CODE, secret.source);
  let stretched: Uint8Array | undefined;
  try {
    stretched = await argon2id(password, salt, params);
    return hkdfSha256(stretched, new Uint8Array(0), encodeUtf8(INFO), KEY_LENGTH);
  } finally {
    wipe(password, stretched);
  }
}

function assertSecret(secret: RecoveryCodeSecret, what: string): void {
  if (typeof secret !== 'object' || secret === null) {
    throw argument(`${what}: the code must be an object`);
  }
  assertBytes(secret.secret, `${what}: code`);
}

/**
 * The kit's key-encryption key for a code, salt and KDF parameters (the vectors' `kek`). The
 * parameters must be within the 04 §2.8 floor and cap. Wipe the result when done.
 */
export function deriveRecoveryKitKek(
  secret: RecoveryCodeSecret,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  assertSecret(secret, 'deriveRecoveryKitKek');
  assertBytes(salt, 'deriveRecoveryKitKek: salt');
  if (salt.length !== SALT_LENGTH) {
    throw new CryptoInputError('invalid_length', 'recovery kit: the salt must be 16 bytes');
  }
  if (typeof params !== 'object' || params === null || !kdfInBounds(params)) {
    throw argument('KDF parameters must be within the 04 §2.8 floor and cap');
  }
  return kitKek(secret, salt, params);
}

// --- manifest (byte grammar; the JCS form is unique for these values) -----------------------------

const AGENT_NAME_MAX = 32;
const KIT_ID_CHARS = 22;
const KIT_ID_BYTES = 16;

const ascii = (text: string): Uint8Array => encodeUtf8(text);
const isLowerHex = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);
const isLower = (b: number): boolean => b >= 0x61 && b <= 0x7a;
const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39;
function sextet(b: number): number {
  if (b >= 0x41 && b <= 0x5a) return b - 0x41;
  if (b >= 0x61 && b <= 0x7a) return b - 0x61 + 26;
  if (b >= 0x30 && b <= 0x39) return b - 0x30 + 52;
  if (b === 0x2d) return 62;
  if (b === 0x5f) return 63;
  return -1;
}
const nibble = (b: number): number => (b <= 0x39 ? b - 0x30 : b - 0x61 + 10);

interface ManifestAgent {
  /** `0x` + 40 lowercase hex, as ASCII bytes (a view into the manifest). */
  readonly agentId: Uint8Array;
  /** The local agent name, ASCII bytes (a view into the manifest). */
  readonly name: Uint8Array;
}

interface Manifest {
  readonly kitId: Uint8Array;
  readonly createdAt: number;
  readonly contents: RecoveryKitContents;
  readonly ownerNostr: Uint8Array;
  readonly agents: readonly ManifestAgent[];
}

/**
 * Reads the manifest exactly as JCS writes
 * `{"agents":[{"agentId":…,"name":…}…],"contents":…,"createdAt":…,"kitId":…,"ownerNostr":…,"v":1}`
 * (keys in RFC 8785 order, no whitespace, no escapes: every allowed value is plain ASCII, so this is
 * the only canonical spelling). Anything else is `undefined`. Works on bytes; makes no string.
 */
function parseManifest(bytes: Uint8Array): Manifest | undefined {
  let at = 0;
  const lit = (text: string): boolean => {
    const want = ascii(text);
    if (at + want.length > bytes.length) return false;
    for (let i = 0; i < want.length; i += 1) if (bytes[at + i] !== want[i]) return false;
    at += want.length;
    return true;
  };
  /** Bytes up to the next `"` that all pass `ok`; at least `min`, at most `max`. */
  const run = (ok: (b: number) => boolean, min: number, max: number): Uint8Array | undefined => {
    const start = at;
    while (at < bytes.length && bytes[at] !== 0x22 && at - start <= max) {
      if (!ok(bytes[at] as number)) return undefined;
      at += 1;
    }
    const n = at - start;
    return n < min || n > max ? undefined : bytes.subarray(start, at);
  };
  if (!lit('{"agents":[')) return undefined;
  const agents: ManifestAgent[] = [];
  if (!lit(']')) {
    for (;;) {
      if (agents.length === RECOVERY_KIT_LIMITS.maxAgents) return undefined;
      if (!lit('{"agentId":"0x')) return undefined;
      const hex = run(isLowerHex, 40, 40);
      if (hex === undefined || !lit('","name":"')) return undefined;
      const name = run((b) => isLower(b) || isDigit(b) || b === 0x2d, 1, AGENT_NAME_MAX);
      if (name === undefined || !isLower(name[0] as number) || !lit('"}')) return undefined;
      const agentId = bytes.subarray(
        hex.byteOffset - bytes.byteOffset - 2,
        hex.byteOffset - bytes.byteOffset + 40,
      );
      const previous = agents[agents.length - 1];
      if (previous !== undefined && compareBytes(previous.agentId, agentId) >= 0) return undefined;
      // Two agents with one local name would write the same agent folder (IR-M1-9i-b-1).
      if (agents.some((a) => equalBytes(a.name, name))) return undefined;
      agents.push({ agentId, name });
      if (lit(']')) break;
      if (!lit(',')) return undefined;
    }
  }
  let contents: RecoveryKitContents;
  if (lit(',"contents":"full"')) contents = 'full';
  else if (lit(',"contents":"identity"')) contents = 'identity';
  else return undefined;
  if (!lit(',"createdAt":')) return undefined;
  const digitsStart = at;
  while (at < bytes.length && isDigit(bytes[at] as number) && at - digitsStart <= 16) at += 1;
  const digits = bytes.subarray(digitsStart, at);
  if (digits.length === 0 || digits.length > 16 || (digits.length > 1 && digits[0] === 0x30)) {
    return undefined;
  }
  let createdAt = 0;
  for (const d of digits) createdAt = createdAt * 10 + (d - 0x30);
  if (createdAt > Number.MAX_SAFE_INTEGER) return undefined;
  if (!lit(',"kitId":"')) return undefined;
  const kitIdText = run((b) => sextet(b) >= 0, KIT_ID_CHARS, KIT_ID_CHARS);
  if (kitIdText === undefined || !lit('","ownerNostr":"')) return undefined;
  const ownerHex = run(isLowerHex, 64, 64);
  if (ownerHex === undefined || !lit('","v":1}') || at !== bytes.length) return undefined;
  const kitId = decodeKitId(kitIdText);
  if (kitId === undefined) return undefined;
  const ownerNostr = new Uint8Array(OWNER_LENGTH);
  for (let i = 0; i < OWNER_LENGTH; i += 1) {
    ownerNostr[i] =
      (nibble(ownerHex[2 * i] as number) << 4) | nibble(ownerHex[2 * i + 1] as number);
  }
  return { kitId, createdAt, contents, ownerNostr, agents };
}

/** 22 base64url characters to 16 bytes, refusing non-zero trailing bits (one spelling per id). */
function decodeKitId(text: Uint8Array): Uint8Array | undefined {
  const out = new Uint8Array(KIT_ID_BYTES);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const b of text) {
    buffer = ((buffer << 6) | sextet(b)) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >> bits) & 0xff;
      o += 1;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 && o === KIT_ID_BYTES ? out : undefined;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// --- sealing --------------------------------------------------------------------------------------

/** One KeyStore item of an agent (never `s3:*`, D-115 D). The value is copied into the stream. */
export interface RecoveryKitItem {
  readonly name: RecoveryKitItemName;
  readonly value: Uint8Array;
}

/** The store snapshot of an agent: its exact byte length and its bytes, in order. */
export interface RecoveryKitStoreSource {
  readonly length: number;
  readonly chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface RecoveryKitAgentInput {
  /** `0x` + 40 lowercase hex (04 §2.9); the `seed` item must derive it. */
  readonly agentId: string;
  /** The local agent name (06 §6: `[a-z][a-z0-9-]{0,31}`). */
  readonly name: string;
  /** `seed` and `store-key` required; the other three only when the item exists. Any order. */
  readonly items: readonly RecoveryKitItem[];
  readonly store: RecoveryKitStoreSource;
}

export interface RecoveryKitInput {
  /** The 32-byte owner seed; the header's ownerNostr is derived from it. */
  readonly ownerSeed: Uint8Array;
  /** The `kitId` of the `backup.export` actions: 16 bytes as base64url without padding. */
  readonly kitId: string;
  /** Unix seconds, an integer in [0, 2^53 − 1]. */
  readonly createdAt: number;
  readonly contents: RecoveryKitContents;
  /** At most 16 agents, distinct `agentId`s; the kit lists them sorted by `agentId`. */
  readonly agents: readonly RecoveryKitAgentInput[];
}

/** Receives the kit's bytes in order (the CLI's 0600 file). Each buffer is the caller's to keep. */
export type RecoveryKitWrite = (bytes: Uint8Array) => Promise<void> | void;

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

interface CheckedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly items: readonly RecoveryKitItem[];
  readonly store: RecoveryKitStoreSource;
}

function ownerNostrOf(seed: Uint8Array): Uint8Array {
  const key = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unreachable');
  return key.publicKey;
}

function checkInput(input: RecoveryKitInput): CheckedAgent[] {
  if (typeof input !== 'object' || input === null) throw argument('input must be an object');
  assertBytes(input.ownerSeed, 'recovery kit: owner seed');
  if (input.ownerSeed.length !== SEED_LENGTH) {
    throw new CryptoInputError('invalid_length', 'recovery kit: the owner seed must be 32 bytes');
  }
  if (typeof input.kitId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.kitId)) {
    throw argument('kitId must be 16 bytes as base64url without padding');
  }
  decodeBase64url(input.kitId, { length: KIT_ID_BYTES });
  if (
    typeof input.createdAt !== 'number' ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0
  ) {
    throw argument('createdAt must be an integer in [0, 2^53 - 1]');
  }
  if (input.contents !== 'full' && input.contents !== 'identity') {
    throw argument('contents must be full or identity');
  }
  if (!Array.isArray(input.agents) || input.agents.length > RECOVERY_KIT_LIMITS.maxAgents) {
    throw argument('a kit holds at most 16 agents');
  }
  const agents: CheckedAgent[] = [];
  for (const agent of input.agents as readonly RecoveryKitAgentInput[]) {
    if (typeof agent !== 'object' || agent === null) throw argument('each agent is an object');
    if (typeof agent.agentId !== 'string' || !AGENT_ID.test(agent.agentId)) {
      throw argument('agentId must be 0x and 40 lowercase hex');
    }
    if (typeof agent.name !== 'string' || !AGENT_NAME.test(agent.name)) {
      throw argument('the agent name must match [a-z][a-z0-9-]{0,31}');
    }
    if (!Array.isArray(agent.items)) throw argument('items must be an array');
    const items: RecoveryKitItem[] = [];
    for (const name of RECOVERY_KIT_ITEM_NAMES) {
      const found = (agent.items as readonly RecoveryKitItem[]).filter((i) => i?.name === name);
      if (found.length > 1) throw argument('an item appears twice');
      const item = found[0];
      if (item === undefined) continue;
      assertBytes(item.value, 'recovery kit: item value');
      if (item.value.length > RECOVERY_KIT_LIMITS.maxItemBytes) {
        throw argument('an item is above 64 KiB');
      }
      items.push(item);
    }
    if (items.length !== agent.items.length) {
      throw argument(
        'items must be seed, store-key, policy-version, receipts-kept, storage-mark or key-epoch',
      );
    }
    if (items[0]?.name !== 'seed' || items[1]?.name !== 'store-key') {
      throw argument('the seed and store-key items are required');
    }
    if (items[0].value.length !== SEED_LENGTH || deriveAgentId(items[0].value) !== agent.agentId) {
      throw argument('the seed item does not derive the agentId');
    }
    const store = agent.store;
    if (
      typeof store !== 'object' ||
      store === null ||
      !Number.isSafeInteger(store.length) ||
      store.length < 0 ||
      store.length > RECOVERY_KIT_LIMITS.maxStoreBytes
    ) {
      throw argument('the store length must be an integer from 0 to 1 GiB');
    }
    agents.push({ agentId: agent.agentId, name: agent.name, items, store });
  }
  agents.sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  for (let i = 1; i < agents.length; i += 1) {
    if (agents[i - 1]?.agentId === agents[i]?.agentId) throw argument('an agent appears twice');
  }
  if (new Set(agents.map((a) => a.name)).size !== agents.length) {
    throw argument('two agents have the same name');
  }
  return agents;
}

function entryHead(name: string, valueLength: number): Uint8Array {
  const raw = ascii(name);
  const out = new Uint8Array(ENTRY_HEAD + raw.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, raw.length, false);
  out.set(raw, 2);
  view.setUint32(2 + raw.length, Math.floor(valueLength / 2 ** 32), false);
  view.setUint32(6 + raw.length, valueLength >>> 0, false);
  return out;
}

/** Seals with the given code, salt, nonce prefix and chunk size. Only sealRecoveryKit and tests. */
export async function sealRecoveryKitWithUnsafe(
  code: Uint8Array,
  salt: Uint8Array,
  noncePrefix: Uint8Array,
  chunkSize: number,
  params: Argon2idParams,
  input: RecoveryKitInput,
  write: RecoveryKitWrite,
): Promise<void> {
  assertBytes(code, 'recovery kit: code');
  assertBytes(salt, 'recovery kit: salt');
  assertBytes(noncePrefix, 'recovery kit: nonce prefix');
  if (salt.length !== SALT_LENGTH || noncePrefix.length !== NONCE_PREFIX_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'recovery kit: the salt must be 16 bytes and the nonce prefix 8 bytes',
    );
  }
  if (!isStreamChunkSize(chunkSize)) throw argument('chunkSize must be from 1 B to 16 MiB');
  if (typeof params !== 'object' || params === null || !kdfInBounds(params)) {
    throw argument('KDF parameters must be within the 04 §2.8 floor and cap');
  }
  if (typeof write !== 'function') throw argument('write must be a function');
  const agents = checkInput(input);
  const ownerNostr = ownerNostrOf(input.ownerSeed);
  const manifest = canonicalizeToBytes({
    v: 1,
    kitId: input.kitId,
    createdAt: input.createdAt,
    contents: input.contents,
    ownerNostr: hexOf(ownerNostr),
    agents: agents.map((a) => ({ agentId: a.agentId, name: a.name })),
  });
  try {
    if (manifest.length > RECOVERY_KIT_LIMITS.maxItemBytes) throw argument('manifest above 64 KiB');
    // The whole kit's size is known before anything is written: refuse above 4 GiB (04 §2.3.3).
    let plaintext = ENTRY_HEAD * 2 + 'manifest'.length + manifest.length + 'owner/seed'.length + 32;
    for (const a of agents) {
      for (const item of a.items)
        plaintext += ENTRY_HEAD + `agent/${a.agentId}/item/${item.name}`.length + item.value.length;
      plaintext += ENTRY_HEAD + `agent/${a.agentId}/store`.length + a.store.length;
    }
    const chunks = Math.max(1, Math.ceil(plaintext / chunkSize));
    if (
      RECOVERY_KIT_HEADER_LENGTH + plaintext + chunks * ALF1_TAG_LENGTH >
      RECOVERY_KIT_LIMITS.maxKitBytes
    ) {
      throw argument('the kit would be above 4 GiB');
    }
    const kek = await kitKek({ secret: code, source: 'prompt' }, salt, params);
    const header = encodeHeader(params, salt, chunkSize, noncePrefix, ownerNostr);
    const sealer = createStreamSealerAt(
      ALKK_FORMAT,
      streamKeyOf(kek, 'recovery kit: kek'),
      header,
      0,
    );
    wipe(kek);
    try {
      const push = async (bytes: Uint8Array): Promise<void> => {
        for (const piece of await sealer.update(bytes)) await write(piece);
      };
      await push(entryHead('manifest', manifest.length));
      await push(manifest);
      await push(entryHead('owner/seed', SEED_LENGTH));
      await push(input.ownerSeed);
      for (const a of agents) {
        for (const item of a.items) {
          await push(entryHead(`agent/${a.agentId}/item/${item.name}`, item.value.length));
          await push(item.value);
        }
        await push(entryHead(`agent/${a.agentId}/store`, a.store.length));
        let written = 0;
        for await (const piece of a.store.chunks) {
          assertBytes(piece, 'recovery kit: store bytes');
          written += piece.length;
          if (written > a.store.length) throw argument('the store is longer than its length');
          await push(piece);
        }
        if (written !== a.store.length) throw argument('the store is shorter than its length');
      }
      const { output } = await sealer.finish();
      for (const piece of output) await write(piece);
    } finally {
      sealer.abort();
    }
  } finally {
    wipe(manifest);
  }
}

function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * 04 §2.3.3 `ALKK` v1: seals the owner seed and, per agent, its items and store into a kit under a
 * new generated recovery code (D-115 B), with a fresh salt and nonce prefix, 1 MiB chunks and
 * Argon2id at `params` (default m = 64 MiB, t = 3, p = 1). Every input is checked before anything is
 * written (formats, the seed of each agent derives its agentId, the caps, a kit of at most 4 GiB);
 * the agents are written sorted by agentId. The kit goes to `write` in order; on any error the
 * caller deletes what was written. Returns the recovery code, 24 base32 characters in six groups of
 * four (ASCII bytes): display only, and wipe it when done.
 */
export async function sealRecoveryKit(
  input: RecoveryKitInput,
  write: RecoveryKitWrite,
  params: Argon2idParams = KEYSTORE_KDF_DEFAULTS,
): Promise<Uint8Array> {
  const code = generateRecoveryCode();
  try {
    await sealRecoveryKitWithUnsafe(
      code,
      randomBytes(SALT_LENGTH),
      randomBytes(NONCE_PREFIX_LENGTH),
      RECOVERY_KIT_DEFAULT_CHUNK_SIZE,
      params,
      input,
      write,
    );
    return code;
  } catch (error) {
    wipe(code);
    throw error;
  }
}

// --- opening --------------------------------------------------------------------------------------

/**
 * Where a store value goes while the kit decrypts: the restore's private temporary file (04 §4
 * quarantine rules, D-84). `write` gets each piece in order (the buffer is the sink's). `commit` is
 * called on every sink, in kit order, only after the whole kit authenticated and every check
 * passed; until then the bytes stay quarantined. `discard` deletes them and is called on every
 * failure, before the kit is authenticated or after, including after a commit when a later commit
 * fails.
 */
export interface RecoveryKitStoreSink {
  write(bytes: Uint8Array): Promise<void> | void;
  commit(): Promise<void> | void;
  discard(): Promise<void> | void;
}

export interface OpenRecoveryKitOptions {
  /** The owner the caller expects (an existing owner item's key); another header owner is refused. */
  readonly expectedOwnerNostr?: Uint8Array;
  /** Called once per store entry, in kit order, when its first byte is about to arrive. */
  readonly createStoreSink: () => RecoveryKitStoreSink | Promise<RecoveryKitStoreSink>;
}

export interface OpenedRecoveryKitItem {
  readonly name: RecoveryKitItemName;
  readonly value: Uint8Array;
}

export interface OpenedRecoveryKitAgent {
  /** `0x` + 40 lowercase hex, derived from the agent seed (equal to the manifest's agentId). */
  readonly agentId: string;
  /** The local agent name as ASCII bytes (`[a-z][a-z0-9-]{0,31}`), from the manifest. */
  readonly name: Uint8Array;
  /** In kit order; `seed` and `store-key` first. */
  readonly items: readonly OpenedRecoveryKitItem[];
  /** The sink that holds the agent's store snapshot, and its byte length. */
  readonly store: RecoveryKitStoreSink;
  readonly storeLength: number;
}

export interface OpenedRecoveryKit {
  readonly ownerNostr: Uint8Array;
  readonly ownerSeed: Uint8Array;
  /** The 16 raw bytes of the manifest's kitId. */
  readonly kitId: Uint8Array;
  readonly createdAt: number;
  readonly contents: RecoveryKitContents;
  /** In manifest order (sorted by agentId). */
  readonly agents: readonly OpenedRecoveryKitAgent[];
  /** The manifest entry's bytes (JCS), as the kit held them. */
  readonly manifest: Uint8Array;
  /** Wipes the owner seed, the items and the manifest (the stores stay with their sinks). */
  wipe(): void;
}

/** A kit to open: the whole kit, or its bytes in order (for example a file read stream). */
export type RecoveryKitSource = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
type KitSource = RecoveryKitSource;

interface Entry {
  readonly name: Uint8Array;
  readonly value: Uint8Array | undefined;
  readonly store: RecoveryKitStoreSink | undefined;
  readonly length: number;
}

const STORE_PREFIX = ascii('agent/');
const STORE_SUFFIX = ascii('/store');
const MAX_ENTRIES = 2 + RECOVERY_KIT_LIMITS.maxAgents * (RECOVERY_KIT_ITEM_NAMES.length + 1);

/** A caller error (a sink or the source failed), passed through instead of `open_failed`. */
class CallerError {
  constructor(readonly error: unknown) {}
}

/**
 * Splits the authenticated plaintext into entries while it arrives, only as far as routing needs:
 * secret values into exact-size memory buffers, store values into sinks. Refuses (open_failed) a
 * value above its cap, a length beyond 2^53, more entries than a kit can hold, and, at `finish`,
 * an incomplete entry. Names are not interpreted beyond "is this a store".
 */
class EntrySplitter {
  readonly entries: Entry[] = [];
  readonly sinks: RecoveryKitStoreSink[] = [];
  private readonly head = new Uint8Array(2 + 65_535 + 8);
  private headFilled = 0;
  private headNeed = 2;
  private nameLength = -1;
  private current:
    | {
        name: Uint8Array;
        value?: Uint8Array;
        store?: RecoveryKitStoreSink;
        length: number;
        filled: number;
      }
    | undefined;

  constructor(private readonly createSink: OpenRecoveryKitOptions['createStoreSink']) {}

  async push(bytes: Uint8Array): Promise<void> {
    let at = 0;
    while (at < bytes.length) {
      if (this.current === undefined) {
        const n = Math.min(this.headNeed - this.headFilled, bytes.length - at);
        this.head.set(bytes.subarray(at, at + n), this.headFilled);
        this.headFilled += n;
        at += n;
        if (this.headFilled === this.headNeed) await this.headDone();
        continue;
      }
      const c = this.current;
      const n = Math.min(c.length - c.filled, bytes.length - at);
      if (c.value !== undefined) c.value.set(bytes.subarray(at, at + n), c.filled);
      else await this.sinkWrite(c.store as RecoveryKitStoreSink, bytes.slice(at, at + n));
      c.filled += n;
      at += n;
      if (c.filled === c.length) this.close();
    }
  }

  private async headDone(): Promise<void> {
    const view = new DataView(this.head.buffer);
    if (this.nameLength < 0) {
      this.nameLength = view.getUint16(0, false);
      this.headNeed = 2 + this.nameLength + 8;
      return;
    }
    const n = this.nameLength;
    const high = view.getUint32(2 + n, false);
    const low = view.getUint32(6 + n, false);
    if (high > MAX_SAFE_HIGH) throw openFailed();
    const length = high * 2 ** 32 + low;
    const name = this.head.slice(2, 2 + n);
    const isStore =
      n >= STORE_PREFIX.length + STORE_SUFFIX.length &&
      equalBytes(name.subarray(0, STORE_PREFIX.length), STORE_PREFIX) &&
      equalBytes(name.subarray(n - STORE_SUFFIX.length), STORE_SUFFIX);
    const cap = isStore ? RECOVERY_KIT_LIMITS.maxStoreBytes : RECOVERY_KIT_LIMITS.maxItemBytes;
    if (length > cap || this.entries.length + 1 > MAX_ENTRIES) throw openFailed();
    if (isStore && this.sinks.length === RECOVERY_KIT_LIMITS.maxAgents) throw openFailed();
    this.head.fill(0, 0, this.headNeed);
    this.headFilled = 0;
    this.headNeed = 2;
    this.nameLength = -1;
    if (isStore) {
      let store: RecoveryKitStoreSink;
      try {
        store = await this.createSink();
      } catch (error) {
        throw new CallerError(error);
      }
      this.sinks.push(store);
      this.current = { name, store, length, filled: 0 };
    } else {
      this.current = { name, value: new Uint8Array(length), length, filled: 0 };
    }
    if (length === 0) this.close();
  }

  private async sinkWrite(sink: RecoveryKitStoreSink, bytes: Uint8Array): Promise<void> {
    try {
      await sink.write(bytes);
    } catch (error) {
      throw new CallerError(error);
    }
  }

  private close(): void {
    const c = this.current as NonNullable<EntrySplitter['current']>;
    this.entries.push({ name: c.name, value: c.value, store: c.store, length: c.length });
    this.current = undefined;
  }

  /** True when the plaintext ended exactly at an entry boundary. */
  complete(): boolean {
    return this.current === undefined && this.headFilled === 0;
  }

  wipe(): void {
    wipe(this.head, ...this.entries.map((e) => e.value), this.current?.value);
  }
}

/** The checks after the final chunk authenticates (04 §2.3.3); `undefined` when any fails. */
function checkEntries(
  entries: readonly Entry[],
  headerOwner: Uint8Array,
): { manifest: Manifest; agents: OpenedRecoveryKitAgent[] } | undefined {
  const [first, second] = entries;
  if (first === undefined || second === undefined) return undefined;
  if (!equalBytes(first.name, ascii('manifest')) || first.value === undefined) return undefined;
  if (!equalBytes(second.name, ascii('owner/seed')) || second.value === undefined) return undefined;
  const manifest = parseManifest(first.value);
  if (manifest === undefined || !equalBytes(manifest.ownerNostr, headerOwner)) return undefined;
  if (second.value.length !== SEED_LENGTH || !equalBytes(ownerNostrOf(second.value), headerOwner)) {
    return undefined;
  }
  const agents: OpenedRecoveryKitAgent[] = [];
  let k = 2;
  for (const agent of manifest.agents) {
    const prefix = new Uint8Array([...ascii('agent/'), ...agent.agentId, 0x2f]);
    const items: OpenedRecoveryKitItem[] = [];
    let next = 0; // the lowest item index still allowed
    let store: Entry | undefined;
    while (store === undefined) {
      const e = entries[k];
      k += 1;
      if (e === undefined) return undefined;
      if (equalBytes(e.name, new Uint8Array([...prefix, ...ascii('store')]))) {
        if (e.store === undefined) return undefined;
        store = e;
        break;
      }
      let found = -1;
      for (let i = next; i < RECOVERY_KIT_ITEM_NAMES.length && found < 0; i += 1) {
        const want = new Uint8Array([...prefix, ...ascii(`item/${RECOVERY_KIT_ITEM_NAMES[i]}`)]);
        if (equalBytes(e.name, want)) found = i;
      }
      if (found < 0 || e.value === undefined) return undefined;
      items.push({ name: RECOVERY_KIT_ITEM_NAMES[found] as RecoveryKitItemName, value: e.value });
      next = found + 1;
    }
    if (
      items.length < REQUIRED_ITEMS ||
      items[0]?.name !== 'seed' ||
      items[1]?.name !== 'store-key'
    ) {
      return undefined;
    }
    const seed = items[0].value;
    if (seed.length !== SEED_LENGTH) return undefined;
    const agentId = deriveAgentId(seed);
    if (!equalBytes(ascii(agentId), agent.agentId)) return undefined;
    agents.push(
      Object.freeze({
        agentId,
        name: agent.name.slice(),
        items: Object.freeze(items),
        store: store.store as RecoveryKitStoreSink,
        storeLength: store.length,
      }),
    );
  }
  if (k !== entries.length) return undefined;
  return { manifest, agents };
}

async function discardAll(sinks: readonly RecoveryKitStoreSink[]): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.discard();
    } catch {
      // Best effort: the caller removes stale quarantine files at start-up (D-84).
    }
  }
}

async function* chunksOf(kit: KitSource): AsyncGenerator<Uint8Array> {
  if (kit instanceof Uint8Array) {
    yield kit;
    return;
  }
  for await (const piece of kit as AsyncIterable<Uint8Array>) {
    assertBytes(piece, 'recovery kit: kit bytes');
    yield piece;
  }
}

/**
 * Opens with a known kek (the code path after Argon2id; vectors and tests). Production restores use
 * openRecoveryKit with the code.
 */
export function openRecoveryKitWithKek(
  kit: KitSource,
  kek: Uint8Array,
  options: OpenRecoveryKitOptions,
  limits?: { readonly maxKitBytes?: number },
): Promise<OpenedRecoveryKit> {
  assertBytes(kek, 'recovery kit: kek');
  if (kek.length !== KEY_LENGTH) {
    throw new CryptoInputError('invalid_length', 'recovery kit: the kek must be 32 bytes');
  }
  const copy = kek.slice();
  // The copy is wiped however the open ends, a header refused before the key is used included.
  return openWith(kit, () => Promise.resolve(copy), options, limits).finally(() => wipe(copy));
}

/**
 * 04 §2.3.3: opens an `ALKK` v1 kit with its recovery code. `kit` is the whole kit or its bytes in
 * order (for example a file read stream). Refused before the KDF (`open_failed`): every header
 * check of readRecoveryKitHeader and a header owner other than `expectedOwnerNostr`; a code that is
 * not 24 base32 characters is `invalid_secret`. While the body decrypts, secret entries are kept in
 * memory and each store value goes to a new sink from `createStoreSink`. Only after the final chunk
 * authenticates are the entry names, order and caps, the manifest, the owner seed (it must derive
 * the header owner) and each agent seed (it must derive its agentId) checked; then every sink is
 * committed. Any failure is one
 * `open_failed` error: everything is wiped and every sink discarded. A failing sink or source
 * passes its own error through, after the same clean-up. Call `wipe()` on the result when done.
 */
export function openRecoveryKit(
  kit: KitSource,
  secret: RecoveryCodeSecret,
  options: OpenRecoveryKitOptions,
): Promise<OpenedRecoveryKit> {
  assertSecret(secret, 'openRecoveryKit');
  return openWith(kit, (fields) => kitKek(secret, fields.salt, fields.params), options);
}

async function openWith(
  kit: KitSource,
  kekFor: (fields: HeaderFields) => Promise<Uint8Array>,
  options: OpenRecoveryKitOptions,
  limits: { readonly maxKitBytes?: number } = {},
): Promise<OpenedRecoveryKit> {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.createStoreSink !== 'function'
  ) {
    throw argument('options.createStoreSink must be a function');
  }
  const expected = options.expectedOwnerNostr;
  if (
    expected !== undefined &&
    (!(expected instanceof Uint8Array) || expected.length !== OWNER_LENGTH)
  ) {
    throw argument('the expected owner key must be 32 bytes');
  }
  const maxKit = limits.maxKitBytes ?? RECOVERY_KIT_LIMITS.maxKitBytes;
  const splitter = new EntrySplitter(options.createStoreSink);
  const source = chunksOf(kit);
  const header = new Uint8Array(RECOVERY_KIT_HEADER_LENGTH);
  let headerFilled = 0;
  let total = 0;
  let opener: Alf1Processor | undefined;
  try {
    try {
      // 1. The header, checked before the KDF.
      let rest: Uint8Array | undefined;
      for (;;) {
        const step = await nextOf(source);
        if (step === undefined) throw openFailed();
        total += step.length;
        if (total > maxKit) throw openFailed();
        const n = Math.min(RECOVERY_KIT_HEADER_LENGTH - headerFilled, step.length);
        header.set(step.subarray(0, n), headerFilled);
        headerFilled += n;
        if (headerFilled === RECOVERY_KIT_HEADER_LENGTH) {
          rest = step.subarray(n);
          break;
        }
      }
      const fields = parseHeader(header);
      if (fields === undefined) throw openFailed();
      if (expected !== undefined && !equalBytes(fields.ownerNostr, expected)) throw openFailed();
      // 2. The key (password() refuses a malformed code here, before Argon2id).
      const kek = await kekFor(fields);
      opener = createStreamOpenerAt(ALKK_FORMAT, streamKeyOf(kek, 'recovery kit: kek'), 0);
      wipe(kek);
      // 3. The body: route each authenticated chunk's plaintext as it arrives.
      const route = async (pieces: readonly Uint8Array[]): Promise<void> => {
        try {
          for (const piece of pieces) await splitter.push(piece);
        } finally {
          wipe(...pieces);
        }
      };
      const feed = async (bytes: Uint8Array): Promise<void> => {
        await route(await (opener as Alf1Processor).update(bytes));
      };
      await feed(header);
      if (rest.length > 0) await feed(rest);
      for (;;) {
        const step = await nextOf(source);
        if (step === undefined) break;
        total += step.length;
        if (total > maxKit) throw openFailed();
        await feed(step);
      }
      await route((await opener.finish()).output);
      // 4. Only now, with the whole kit authentic: the entry list, the manifest and the seeds.
      if (!splitter.complete()) throw openFailed();
      const checked = checkEntries(splitter.entries, fields.ownerNostr);
      if (checked === undefined) throw openFailed();
      const { manifest, agents } = checked;
      const ownerSeed = (splitter.entries[1] as Entry).value as Uint8Array;
      const manifestBytes = (splitter.entries[0] as Entry).value as Uint8Array;
      const secrets = splitter.entries.map((e) => e.value);
      // 5. Every check passed: release the quarantined stores. A failing commit is the caller's error.
      for (const sink of splitter.sinks) {
        try {
          await sink.commit();
        } catch (error) {
          throw new CallerError(error);
        }
      }
      return Object.freeze({
        ownerNostr: fields.ownerNostr.slice(),
        ownerSeed,
        kitId: manifest.kitId,
        createdAt: manifest.createdAt,
        contents: manifest.contents,
        agents: Object.freeze(agents),
        manifest: manifestBytes,
        wipe(): void {
          wipe(...secrets, manifestBytes, ownerSeed, manifest.ownerNostr);
        },
      });
    } catch (error) {
      if (error instanceof CallerError) throw error;
      if (error instanceof CryptoInputError) {
        // A malformed code and caller argument errors keep their codes; everything else is generic.
        if (error.code === 'invalid_secret' || error.code === 'invalid_argument') {
          if (opener === undefined) throw error;
        }
        throw openFailed();
      }
      throw new CallerError(error);
    }
  } catch (error) {
    opener?.abort();
    wipe(header);
    splitter.wipe();
    await discardAll(splitter.sinks);
    try {
      await source.return(undefined);
    } catch {
      // The source's own clean-up failed; the kit is refused either way.
    }
    throw error instanceof CallerError ? error.error : error;
  } finally {
    opener?.abort();
  }
}

async function nextOf(source: AsyncGenerator<Uint8Array>): Promise<Uint8Array | undefined> {
  let step: IteratorResult<Uint8Array>;
  try {
    step = await source.next();
  } catch (error) {
    if (error instanceof CryptoInputError) throw error;
    throw new CallerError(error);
  }
  return step.done === true ? undefined : step.value;
}
