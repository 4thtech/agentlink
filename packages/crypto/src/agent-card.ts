// The AgentCard (04 §2.4): its EIP-712 type under the chain-agnostic domain, its JSON form, the
// owner's `cardSig`, the agent key's `cardAgentSig` (04 §2.9, mandatory on invite and handshake) and
// `sha256(JCS(card))` (04 §3.6).
//
// Every function parses the card strictly first and works on that parsed, frozen copy, so what is
// checked is what is hashed and signed. The parse is structural (04 §2.4, §2.4.1): exactly the
// twelve fields; `0x` + lowercase hex addresses and bytes32; JSON integers in [0, 2^53 - 1] and in
// range for their uint type; `version` 1; `agentEvm` != `ownerEvm` (§2.9). Time rules (expiry,
// `expiresAt` after `issuedAt`) and the off-chain name and relay rules belong to the callers that
// know the clock and the relay policy (@4thtech-io/types, the core).
//
// Errors never contain the input (I-7): see errors.ts.
import { decodeEcdsaSignature, recoverEvmAddress } from './ecdsa.js';
import { equalBytes } from './bytes.js';
import {
  eip712TypeHash,
  hashTypedData,
  signTypedData,
  type TypedDataHashes,
  type TypedDataTypes,
} from './eip712.js';
import { decodeHex0x, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { keccak256, sha256 } from './hash.js';
import { canonicalizeToBytes, parseReceivedJson } from './jcs.js';

/** An AgentCard in its JSON form (04 §2.4), as parseAgentCard returns it. */
export interface AgentCard {
  readonly version: number;
  readonly agentEvm: string;
  readonly agentNostr: string;
  readonly agentEnc: string;
  readonly ownerEvm: string;
  readonly ownerNostr: string;
  readonly ownerEnc: string;
  readonly nameHash: string;
  readonly relaysHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyEpoch: number;
}

/** The EIP-712 hashes of a card, with the AgentCard type hash. */
export interface AgentCardHashes extends TypedDataHashes {
  readonly typeHash: Uint8Array;
}

/** 04 §2.4: chain-agnostic, no chainId and no verifyingContract, so one signature serves every chain. */
export const AGENT_CARD_DOMAIN = Object.freeze({ name: 'OCC AgentCard', version: '1' } as const);

const field = (name: string, type: string) => Object.freeze({ name, type });

/** The EIP-712 types of the card, in the field order of 04 §2.4. */
export const AGENT_CARD_TYPES: TypedDataTypes = Object.freeze({
  EIP712Domain: Object.freeze([field('name', 'string'), field('version', 'string')]),
  AgentCard: Object.freeze([
    field('version', 'uint8'),
    field('agentEvm', 'address'),
    field('agentNostr', 'bytes32'),
    field('agentEnc', 'bytes32'),
    field('ownerEvm', 'address'),
    field('ownerNostr', 'bytes32'),
    field('ownerEnc', 'bytes32'),
    field('nameHash', 'bytes32'),
    field('relaysHash', 'bytes32'),
    field('issuedAt', 'uint64'),
    field('expiresAt', 'uint64'),
    field('keyEpoch', 'uint32'),
  ]),
});

const ADDRESS_FIELDS = ['agentEvm', 'ownerEvm'] as const;
const BYTES32_FIELDS = [
  'agentNostr',
  'agentEnc',
  'ownerNostr',
  'ownerEnc',
  'nameHash',
  'relaysHash',
] as const;
/** Largest value per integer field: the uint type's maximum, capped at 2^53 - 1 (04 §2.4.1). */
const INTEGER_FIELDS = {
  version: 1, // 04 §2.4: version is 1; checked exactly below
  issuedAt: Number.MAX_SAFE_INTEGER,
  expiresAt: Number.MAX_SAFE_INTEGER,
  keyEpoch: 2 ** 32 - 1,
} as const;
const FIELD_COUNT = 12;

const invalidCard = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_card', message);

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An own data property; a getter is refused unread, so it cannot change between check and use. */
function dataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw invalidCard('card fields must be plain data properties');
  }
  return descriptor.value as unknown;
}

function canonicalHex(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string')
    throw invalidCard('card address and bytes32 fields must be strings');
  try {
    return decodeHex0x(value, { length });
  } catch {
    throw invalidCard('card address and bytes32 fields must be 0x + lowercase hex of their size');
  }
}

/**
 * Parses a card in its JSON form (04 §2.4, §2.4.1) and returns a frozen copy with exactly the twelve
 * fields. Refuses, never normalises: a missing or extra field, accessor or symbol properties, a
 * non-plain object, EIP-55 or upper-case hex, a missing `0x` or `0X`, a wrong length, a non-integer,
 * negative, -0 or out-of-range integer, a `version` other than 1, and `agentEvm` equal to
 * `ownerEvm` (04 §2.9).
 *
 * An object no longer shows how its numbers were spelled, so this cannot refuse the tokens `1.0`,
 * `1e3` or `-0` (04 §2.4.1; IR-M1-1e-1 I-2), nor escaped or duplicate member names (04 §2.5.1,
 * D-128). A card read from JSON text must be parsed with parseAgentCardJson, or its enclosing
 * text with parseReceivedJson (or parseJson `integersOnly` and `plainMemberNames`) before it gets
 * here.
 */
export function parseAgentCard(value: unknown): AgentCard {
  if (!isPlainObject(value)) throw invalidCard('a card must be a plain JSON object');
  const keys = Reflect.ownKeys(value);
  const names = AGENT_CARD_TYPES.AgentCard?.map((f) => f.name) ?? [];
  if (keys.length !== FIELD_COUNT || !names.every((name) => keys.includes(name))) {
    throw invalidCard('a card must have exactly the twelve AgentCard fields');
  }
  const card: Record<string, string | number> = {};
  for (const name of ADDRESS_FIELDS) {
    const raw = dataProperty(value, name);
    canonicalHex(raw, 20);
    card[name] = raw as string;
  }
  for (const name of BYTES32_FIELDS) {
    const raw = dataProperty(value, name);
    canonicalHex(raw, 32);
    card[name] = raw as string;
  }
  for (const [name, max] of Object.entries(INTEGER_FIELDS)) {
    const raw = dataProperty(value, name);
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      Object.is(raw, -0) ||
      raw < 0 ||
      raw > max
    ) {
      throw invalidCard('card integer fields must be JSON integers in range for their type');
    }
    card[name] = raw;
  }
  if (card.version !== 1) throw invalidCard('card version must be 1');
  if (equalBytes(canonicalHex(card.agentEvm, 20), canonicalHex(card.ownerEvm, 20))) {
    throw invalidCard('a card whose agentEvm equals its ownerEvm is refused');
  }
  return Object.freeze(card) as unknown as AgentCard;
}

/**
 * Parses a card from its JSON text with the received-text parse (04 §2.5.1, D-128): strict I-JSON
 * (no duplicate key, 04 §2.4), no member name written with an escape, and every number token a
 * protocol integer (`1.0`, `1e3`, `-0` refused on the token, 04 §2.4.1); then parseAgentCard.
 */
export function parseAgentCardJson(text: string): AgentCard {
  return parseAgentCard(parseReceivedJson(text));
}

const typedData = (card: AgentCard) => ({
  types: AGENT_CARD_TYPES,
  primaryType: 'AgentCard',
  domain: AGENT_CARD_DOMAIN,
  message: card as unknown as Readonly<Record<string, unknown>>,
});

/** The EIP-712 type hash, domain separator, struct hash and digest of a card (04 §2.4). */
export function hashAgentCard(card: unknown): AgentCardHashes {
  const parsed = parseAgentCard(card);
  return {
    typeHash: eip712TypeHash(AGENT_CARD_TYPES, 'AgentCard'),
    ...hashTypedData(typedData(parsed)),
  };
}

/**
 * sha256(JCS(card)) as 32 bytes (04 §3.6: the pairing transcript and `inviterCardHash`): SHA-256 of
 * the RFC 8785 serialisation, in UTF-8, of the card in its JSON form. This is not the EIP-712 digest.
 */
export function agentCardJcsHash(card: unknown): Uint8Array {
  return sha256(canonicalizeToBytes(parseAgentCard(card)));
}

/** nameHash = keccak256(UTF-8 of the display name), exactly as given: no trimming or normalisation. */
export function agentCardNameHash(name: string): Uint8Array {
  if (typeof name !== 'string') {
    throw new CryptoInputError('invalid_argument', 'agentCardNameHash: name must be a string');
  }
  return keccak256(encodeUtf8(name));
}

/** relaysHash = keccak256(JCS(relays)): the list as given, order kept, no normalisation (04 §2.4). */
export function agentCardRelaysHash(relays: readonly string[]): Uint8Array {
  if (!Array.isArray(relays) || !relays.every((relay) => typeof relay === 'string')) {
    throw new CryptoInputError(
      'invalid_argument',
      'agentCardRelaysHash: relays must be an array of strings',
    );
  }
  return keccak256(canonicalizeToBytes(relays));
}

/**
 * Signs a card: canonical ECDSA over its EIP-712 digest, `0x` + 130 lowercase hex (04 §2.4.1). With
 * the owner's EVM key this is `cardSig`; with the agent's EVM key it is `cardAgentSig` (04 §2.9).
 * Refuses a card that does not parse. For KeyStore implementations only; see signDigestEcdsa.
 */
export function signAgentCard(card: unknown, secretKey: Uint8Array): string {
  return signTypedData(typedData(parseAgentCard(card)), secretKey);
}

/** True when `signature` is canonical and its signer is the card's `field`, compared as bytes. */
function signedBy(card: unknown, signature: unknown, field: 'ownerEvm' | 'agentEvm'): boolean {
  try {
    const parsed = parseAgentCard(card);
    if (typeof signature !== 'string') return false;
    const signer = recoverEvmAddress(
      hashTypedData(typedData(parsed)).digest,
      decodeEcdsaSignature(signature),
    );
    return equalBytes(signer, decodeHex0x(parsed[field], { length: 20 }));
  } catch {
    // Any failure is a refusal, including a throwing Proxy trap or getter (IR-M1-1e-1 I-1): a
    // verification answers true or false and never throws on what it is given.
    return false;
  }
}

/**
 * `cardSig` check (04 §2.4): true when the card parses and `cardSig` is a canonical signature by
 * `card.ownerEvm` over the card. False for anything else; it never throws on untrusted input. On
 * its own this suffices only for a `card-update` (04 §2.9); an invite or `handshake` card needs
 * verifyAgentCard.
 */
export function verifyCardOwnerSig(card: unknown, cardSig: unknown): boolean {
  return signedBy(card, cardSig, 'ownerEvm');
}

/**
 * `cardAgentSig` check (04 §2.9): true when the card parses and `cardAgentSig` is a canonical
 * signature by `card.agentEvm` over the same card digest. It shows that the agent key endorsed this
 * owner binding, not liveness: cards and signatures are public and can be replayed.
 */
export function verifyCardAgentSig(card: unknown, cardAgentSig: unknown): boolean {
  return signedBy(card, cardAgentSig, 'agentEvm');
}

/**
 * The full card check for an invite or a `handshake` (04 §2.9, §3.6): both `cardSig` (by
 * `ownerEvm`) and `cardAgentSig` (by `agentEvm`) are required and must verify. A missing
 * `cardAgentSig` fails. Expiry is the caller's check: it needs the clock.
 */
export function verifyAgentCard(card: unknown, cardSig: unknown, cardAgentSig: unknown): boolean {
  return verifyCardOwnerSig(card, cardSig) && verifyCardAgentSig(card, cardAgentSig);
}
