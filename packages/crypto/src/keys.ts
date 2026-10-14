// Key derivation and public identities (04 §2.1, §2.6, §2.9, §3.1 `kid`; drop key §4, D-48).
// Every purpose key comes from the 32-byte master seed through HKDF-SHA256; the curves are
// @noble/curves (04 §8.1), so nothing here implements a primitive (I-8).
//
// Every function that takes the master seed (deriveKey, deriveSecretKey, derivePublicKey,
// deriveAgentId, derivePublicIdentity) is for KeyStore implementations and `init` only (04 §8.1):
// the package exports them only from the restricted subpath @agentlink/crypto/keystore. Every
// other caller gets public values from the KeyStore. Callers wipe returned secrets (`wipe`) when
// done. The master seed is never modified or returned. Errors are fixed sentences that never echo
// an input (I-7).
import { x25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { assertBytes } from './bytes.js';
import { decodeHex0x, encodeHex0x, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { keccak256, sha256 } from './hash.js';
import { hkdfSha256 } from './hkdf.js';
import { isSecp256k1SecretKey } from './secp256k1-range.js';
import { wipe } from './wipe.js';

/** The derivation labels of 04 §2.1, and no others. Frozen. */
export const KEY_LABELS = Object.freeze({
  /** secp256k1, the agent's EVM address (agentId). Always epoch 0. */
  evm: 'agentlink/v1/evm',
  /** secp256k1, BIP-340 Nostr identity. Current keyEpoch. */
  nostr: 'agentlink/v1/nostr',
  /** X25519, HPKE recipient key. Current keyEpoch. */
  enc: 'agentlink/v1/enc',
  /** secp256k1, BIP-340 drop key: signs encrypted-drop requests only, never published. */
  drop: 'agentlink/v1/drop',
} as const);

export type KeyLabel = (typeof KEY_LABELS)[keyof typeof KEY_LABELS];

/** Master seeds are exactly 32 random bytes (04 §2). */
export const MASTER_SEED_LENGTH = 32;

/** Epochs are u32 (04 §2.1 `u32be(epoch)`; the card's `keyEpoch` is a uint32). */
export const MAX_KEY_EPOCH = 0xffffffff;

const SALT = encodeUtf8('agentlink-v1');
const OKM_LENGTH = 32;
const MAX_COUNTER = 0xff;
const LABEL_SET: ReadonlySet<string> = new Set<string>(Object.values(KEY_LABELS));

function assertSeed(masterSeed: unknown): asserts masterSeed is Uint8Array {
  assertBytes(masterSeed, 'key derivation: the master seed');
  if (masterSeed.length !== MASTER_SEED_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'key derivation: the master seed must be 32 bytes',
    );
  }
}

function assertLabel(label: unknown): asserts label is KeyLabel {
  if (typeof label !== 'string' || !LABEL_SET.has(label)) {
    throw new CryptoInputError('invalid_argument', 'key derivation: unknown key label');
  }
}

function assertEpoch(epoch: unknown): asserts epoch is number {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0 || epoch > MAX_KEY_EPOCH) {
    throw new CryptoInputError(
      'invalid_argument',
      'key derivation: the epoch must be an integer from 0 to 2^32 - 1',
    );
  }
}

function assertLabelEpoch(label: unknown, epoch: unknown): asserts label is KeyLabel {
  assertLabel(label);
  assertEpoch(epoch);
  if (label === KEY_LABELS.evm && epoch !== 0) {
    // 04 §2.1: the EVM key is stable; credits, Records and the agentId are tied to it.
    throw new CryptoInputError(
      'invalid_argument',
      'key derivation: the evm key is always derived at epoch 0',
    );
  }
}

function assertCounter(counter: unknown): asserts counter is number {
  if (
    typeof counter !== 'number' ||
    !Number.isInteger(counter) ||
    counter < 0 ||
    counter > MAX_COUNTER
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      'key derivation: the counter must be an integer from 0 to 255',
    );
  }
}

/** info = utf8(label) || 0x00 || u32be(epoch) || u8(counter). */
function infoFor(label: KeyLabel, epoch: number, counter: number): Uint8Array {
  const labelBytes = encodeUtf8(label);
  const info = new Uint8Array(labelBytes.length + 6);
  info.set(labelBytes, 0);
  const view = new DataView(info.buffer);
  view.setUint8(labelBytes.length, 0x00);
  view.setUint32(labelBytes.length + 1, epoch, false);
  view.setUint8(labelBytes.length + 5, counter);
  return info;
}

/**
 * 04 §2.1 exactly: okm = HKDF-SHA256(ikm = masterSeed, salt = utf8("agentlink-v1"),
 * info = utf8(label) || 0x00 || u32be(epoch) || u8(counter), L = 32).
 *
 * This is the raw okm for one counter, before the secp256k1 rejection loop; use deriveSecretKey
 * for a usable key. The result is secret: KeyStore implementations only, and wipe it when done.
 * Refuses a seed that is not 32 bytes, a label outside KEY_LABELS, an epoch outside u32, a counter
 * outside u8, and the EVM label at any epoch other than 0.
 */
export function deriveKey(
  masterSeed: Uint8Array,
  label: KeyLabel,
  epoch: number,
  counter: number,
): Uint8Array {
  assertSeed(masterSeed);
  assertLabelEpoch(label, epoch);
  assertCounter(counter);
  return hkdfSha256(masterSeed, SALT, infoFor(label, epoch, counter), OKM_LENGTH);
}

/**
 * The secp256k1 rejection loop of 04 §2.1: take the okm for counter 0, 1, ... and return the first
 * one that is a valid secret key (as a big-endian integer, not 0 and below the curve order n).
 * Every rejected okm is wiped. After counter 255 it fails closed rather than wrap; reaching that
 * needs 256 consecutive rejections, each with probability about 2^-128.
 *
 * Internal (not exported from the package): exported from this module so a unit test can inject
 * out-of-range values, which no real seed produces in practice.
 */
export function selectSecp256k1SecretKey(okmFor: (counter: number) => Uint8Array): Uint8Array {
  for (let counter = 0; counter <= MAX_COUNTER; counter += 1) {
    const okm = okmFor(counter);
    if (isSecp256k1SecretKey(okm)) return okm;
    wipe(okm);
  }
  throw new CryptoInputError(
    'invalid_argument',
    'key derivation: no counter gives a valid secp256k1 key',
  );
}

/**
 * The secret key for (label, epoch): for secp256k1 labels (evm, nostr, drop) the first valid okm
 * of the rejection loop; for enc the okm itself, used as the X25519 private key (the library
 * clamps per RFC 7748). KeyStore implementations only; wipe the result when done.
 */
export function deriveSecretKey(
  masterSeed: Uint8Array,
  label: KeyLabel,
  epoch: number,
): Uint8Array {
  assertSeed(masterSeed);
  assertLabelEpoch(label, epoch);
  if (label === KEY_LABELS.enc) return deriveKey(masterSeed, label, epoch, 0);
  return selectSecp256k1SecretKey((counter) => deriveKey(masterSeed, label, epoch, counter));
}

/** The 20-byte EVM address of a secp256k1 secret key: keccak256(uncompressed point without 0x04). */
function evmAddressOf(secretKey: Uint8Array): Uint8Array {
  const point = secp256k1.getPublicKey(secretKey, false);
  return keccak256(point.subarray(1)).slice(12);
}

/** 04 §3.1: `kid` = the first 16 bytes of sha256(raw 32-byte encPub). */
export function kidFromEncPublicKey(encPublicKey: Uint8Array): Uint8Array {
  assertBytes(encPublicKey, 'kidFromEncPublicKey: the key');
  if (encPublicKey.length !== 32) {
    throw new CryptoInputError('invalid_length', 'kidFromEncPublicKey: the key must be 32 bytes');
  }
  return sha256(encPublicKey).slice(0, 16);
}

/** The public half of one derived key, by label. */
export type DerivedPublicKey =
  | Readonly<{
      label: typeof KEY_LABELS.evm;
      epoch: 0;
      /** 20 raw bytes. */
      address: Uint8Array;
      /** The same address as text: `0x` + 40 lowercase hex (04 §2.9). */
      agentId: string;
    }>
  | Readonly<{
      label: typeof KEY_LABELS.nostr | typeof KEY_LABELS.drop;
      epoch: number;
      /** 32-byte BIP-340 x-only public key. */
      publicKey: Uint8Array;
    }>
  | Readonly<{
      label: typeof KEY_LABELS.enc;
      epoch: number;
      /** 32-byte X25519 public key. */
      publicKey: Uint8Array;
      /** First 16 bytes of sha256(publicKey) (04 §3.1). */
      kid: Uint8Array;
    }>;

function publicFromSecret(label: KeyLabel, epoch: number, secretKey: Uint8Array): DerivedPublicKey {
  switch (label) {
    case KEY_LABELS.evm: {
      const address = evmAddressOf(secretKey);
      return Object.freeze({ label, epoch: 0, address, agentId: encodeHex0x(address) });
    }
    case KEY_LABELS.enc: {
      const publicKey = x25519.getPublicKey(secretKey);
      return Object.freeze({ label, epoch, publicKey, kid: kidFromEncPublicKey(publicKey) });
    }
    case KEY_LABELS.nostr:
    case KEY_LABELS.drop:
      return Object.freeze({ label, epoch, publicKey: schnorr.getPublicKey(secretKey) });
  }
}

/**
 * The public key for (label, epoch), with the same refusals as deriveKey. The secret key is
 * derived, used and wiped inside this call. A drop key (KEY_LABELS.drop) is returned only when
 * asked for by label; it is never part of derivePublicIdentity (04 §2.1, D-48).
 */
export function derivePublicKey(
  masterSeed: Uint8Array,
  label: KeyLabel,
  epoch: number,
): DerivedPublicKey {
  const secretKey = deriveSecretKey(masterSeed, label, epoch);
  try {
    return publicFromSecret(label, epoch, secretKey);
  } finally {
    wipe(secretKey);
  }
}

/**
 * 04 §2.9: the agent ID, the address of the `agentlink/v1/evm` key at epoch 0, as `0x` + 40
 * lowercase hex. It never changes with keyEpoch.
 */
export function deriveAgentId(masterSeed: Uint8Array): string {
  const key = derivePublicKey(masterSeed, KEY_LABELS.evm, 0);
  if (key.label !== KEY_LABELS.evm) throw new Error('unreachable');
  return key.agentId;
}

/**
 * The agent's public identity at `keyEpoch`: exactly the agent fields of the agent card (04 §2.4)
 * plus `agentId` (text) and `kid`. It never contains the drop key or anything derived from it, so
 * the drop key stays unlinkable to the card, the address and any billing profile (D-48). Frozen.
 */
export interface PublicIdentity {
  /** `0x` + 40 lowercase hex; equal to `agentEvm` (04 §2.9). */
  readonly agentId: string;
  /** 20-byte EVM address (epoch 0). */
  readonly agentEvm: Uint8Array;
  /** 32-byte BIP-340 x-only key at keyEpoch. */
  readonly agentNostr: Uint8Array;
  /** 32-byte X25519 key at keyEpoch. */
  readonly agentEnc: Uint8Array;
  /** First 16 bytes of sha256(agentEnc). */
  readonly kid: Uint8Array;
  readonly keyEpoch: number;
}

export function derivePublicIdentity(masterSeed: Uint8Array, keyEpoch: number): PublicIdentity {
  assertSeed(masterSeed);
  assertEpoch(keyEpoch);
  const evm = derivePublicKey(masterSeed, KEY_LABELS.evm, 0);
  const nostr = derivePublicKey(masterSeed, KEY_LABELS.nostr, keyEpoch);
  const enc = derivePublicKey(masterSeed, KEY_LABELS.enc, keyEpoch);
  if (
    evm.label !== KEY_LABELS.evm ||
    nostr.label !== KEY_LABELS.nostr ||
    enc.label !== KEY_LABELS.enc
  ) {
    throw new Error('unreachable');
  }
  return Object.freeze({
    agentId: evm.agentId,
    agentEvm: evm.address,
    agentNostr: nostr.publicKey,
    agentEnc: enc.publicKey,
    kid: enc.kid,
    keyEpoch,
  });
}

/**
 * EIP-55 mixed-case form of a canonical address, for display only (04 §2.4.1, §2.9). The input
 * must be the canonical `0x` + 40 lowercase hex; a checksummed or upper-case address is refused,
 * because checksummed forms are never accepted as input.
 */
export function evmAddressChecksummed(agentId: string): string {
  decodeHex0x(agentId, { length: 20 });
  const lower = agentId.slice(2);
  const hash = keccak256(encodeUtf8(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower.charAt(i);
    const byte = hash[i >> 1] as number;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}
