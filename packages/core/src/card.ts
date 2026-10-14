// Agent-card checks shared by identity and contacts (04 §2.4, §2.9, §3.4.1). Every check is a call
// into @agentlink/crypto; nothing here touches a primitive. Errors are fixed sentences (I-7).
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  agentCardNameHash,
  agentCardRelaysHash,
  canonicalize,
  decodeHex0x,
  encodeHex,
  encodeHex0x,
  ownerFingerprint,
  parseAgentCard,
  parseJson,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type AgentCard,
  type JsonValue,
  type OwnerPublicKeys,
  type TypedData,
} from '@agentlink/crypto';
import { displayNameSchema, relayListSchema } from '@agentlink/types';
import { CoreError } from './errors.js';

/** A card with its signatures as the store keeps it, sealed in `agent_card_json` (07 §3, M-3). */
export interface StoredCard {
  readonly card: AgentCard;
  readonly cardSig: string;
  /** Null after a card-update, which carries no agent signature (04 §3.4.1). */
  readonly cardAgentSig: string | null;
}

/** The plaintext of a sealed `agent_card_json`: JCS of {card, cardSig, cardAgentSig}. */
export function storedCardText(stored: StoredCard): string {
  return canonicalize({
    card: stored.card as unknown as JsonValue,
    cardSig: stored.cardSig,
    cardAgentSig: stored.cardAgentSig,
  });
}

/**
 * Reads a stored card back and checks it again: the card parses strictly and `cardSig` is by
 * `ownerEvm`; `cardAgentSig`, when present, is by `agentEvm`. Anything else is unreadable (fail
 * closed), never trusted.
 */
export function parseStoredCard(text: string): StoredCard {
  const unreadable = (): never => {
    throw new CoreError('store_unreadable', 'A stored agent card could not be read.');
  };
  let value: unknown;
  try {
    value = parseJson(text, { integersOnly: true });
  } catch {
    return unreadable();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unreadable();
  const { card: rawCard, cardSig, cardAgentSig } = value as Record<string, unknown>;
  let card: AgentCard;
  try {
    card = parseAgentCard(rawCard);
  } catch {
    return unreadable();
  }
  if (typeof cardSig !== 'string' || !verifyCardOwnerSig(card, cardSig)) return unreadable();
  if (cardAgentSig !== null && !verifyCardAgentSig(card, cardAgentSig)) return unreadable();
  return { card, cardSig, cardAgentSig: cardAgentSig as string | null };
}

/** The long owner fingerprint (04 §2.9) of a card, 64 lowercase hex. A hash of public keys only. */
export function ownerFingerprintHex(card: AgentCard): string {
  return encodeHex(
    ownerFingerprint(
      decodeHex0x(card.ownerEvm, { length: 20 }),
      decodeHex0x(card.ownerNostr, { length: 32 }),
      decodeHex0x(card.ownerEnc, { length: 32 }),
    ),
  );
}

/** A card with the signatures and off-chain fields that travel with it (invite, handshake, 04 §3.6). */
export interface SignedCard {
  readonly card: AgentCard;
  /** EIP-712 by `ownerEvm` (04 §2.4). */
  readonly cardSig: string;
  /** EIP-712 by `agentEvm` over the same card (04 §2.9). */
  readonly cardAgentSig: string;
  /** Self-declared display name; `nameHash` = keccak256 of its UTF-8. */
  readonly name: string;
  /** Relay URLs; `relaysHash` = keccak256(JCS(relays)). */
  readonly relays: readonly string[];
}

/** A card as received: every field is untrusted until checked (I-5). */
export interface CardInput {
  readonly card: unknown;
  readonly cardSig: unknown;
  readonly cardAgentSig?: unknown;
  readonly name: unknown;
  readonly relays: unknown;
}

/** The EIP-712 typed data of a card under the chain-agnostic domain (04 §2.4). */
export function cardTypedData(card: AgentCard): TypedData {
  return {
    types: AGENT_CARD_TYPES,
    primaryType: 'AgentCard',
    domain: AGENT_CARD_DOMAIN,
    message: card as unknown as Readonly<Record<string, unknown>>,
  };
}

export function checkName(name: unknown): string {
  const parsed = displayNameSchema.safeParse(name);
  if (!parsed.success) throw new CoreError('name_invalid', 'The display name is not valid.');
  return parsed.data;
}

/** The relay URL rule of 04 §4 on every entry (an SSRF boundary for lists from other parties). */
export function checkRelays(relays: unknown): readonly string[] {
  const parsed = relayListSchema.safeParse(relays);
  if (!parsed.success) throw new CoreError('relays_invalid', 'The relay list is not valid.');
  return Object.freeze([...parsed.data]);
}

export function parseCard(card: unknown): AgentCard {
  try {
    return parseAgentCard(card);
  } catch {
    throw new CoreError('card_invalid', 'The agent card is not valid.');
  }
}

/** The three owner fields of a card, in their card spelling (`0x` + lowercase hex, 04 §2.4.1). */
export interface OwnerKeyFields {
  readonly ownerEvm: string;
  readonly ownerNostr: string;
  readonly ownerEnc: string;
}

export function ownerKeyFields(keys: OwnerPublicKeys): OwnerKeyFields {
  return {
    ownerEvm: encodeHex0x(keys.ownerEvm),
    ownerNostr: encodeHex0x(keys.ownerNostr),
    ownerEnc: encodeHex0x(keys.ownerEnc),
  };
}

/** True when both name exactly the same owner keys. Each value has one spelling, so this is bytes. */
export function sameOwnerKeys(a: OwnerKeyFields, b: OwnerKeyFields): boolean {
  return a.ownerEvm === b.ownerEvm && a.ownerNostr === b.ownerNostr && a.ownerEnc === b.ownerEnc;
}

/** The Nostr form (64 lowercase hex, no `0x`) of the card's agent key: an envelope's `from`. */
export function agentNostrKey(card: AgentCard): string {
  return card.agentNostr.slice(2);
}

/**
 * Checks a received card (04 §2.4, §2.9, §3.4.1): the card parses strictly, `cardSig` is by
 * `ownerEvm`, `cardAgentSig` by `agentEvm` when required (invite, handshake; not a card-update), the
 * name and relays match their hashes and pass their rules, and the card has not expired at `now`.
 */
export function checkReceivedCard(
  input: CardInput,
  options: { readonly requireAgentSig: boolean; readonly now: number },
): Omit<SignedCard, 'cardAgentSig'> & { readonly cardAgentSig: string | null } {
  const card = parseCard(input.card);
  if (!verifyCardOwnerSig(card, input.cardSig)) {
    throw new CoreError(
      'card_owner_signature_invalid',
      'The agent card is not signed by its owner key.',
    );
  }
  let cardAgentSig: string | null = null;
  if (options.requireAgentSig || input.cardAgentSig !== undefined) {
    if (!verifyCardAgentSig(card, input.cardAgentSig)) {
      throw new CoreError(
        'card_agent_signature_invalid',
        'The agent card is not endorsed by its agent key.',
      );
    }
    cardAgentSig = input.cardAgentSig as string;
  }
  const name = checkName(input.name);
  if (encodeHex0x(agentCardNameHash(name)) !== card.nameHash) {
    throw new CoreError('name_invalid', 'The display name does not match the agent card.');
  }
  const relays = checkRelays(input.relays);
  if (encodeHex0x(agentCardRelaysHash(relays)) !== card.relaysHash) {
    throw new CoreError('relays_invalid', 'The relay list does not match the agent card.');
  }
  if (card.expiresAt !== 0 && card.expiresAt <= options.now) {
    throw new CoreError('card_expired', 'The agent card has expired.');
  }
  return { card, cardSig: input.cardSig as string, cardAgentSig, name, relays };
}
