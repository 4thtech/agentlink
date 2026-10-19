// The agent card's proof of possession (M1-4d-d; 04 §2.9, 07 §8; D-102). Two signatures over one
// card show that both of the agent's keys named in it signed that card:
// - `cardAgentSig`: EIP-712 by the card's `agentEvm` (agent-card.ts, verifyCardAgentSig);
// - `cardPop`: BIP-340 by the card's `agentNostr` over taggedHash(TAGS.cardPop, sha256(JCS(card))).
// The tag differs from the envelope and owner-action tags, so a `cardPop` is never a valid envelope,
// owner-action or Nostr event signature, and the reverse. Both cover the whole card, so a signature
// moved to another card (another epoch, owner, name or key) fails.
//
// signCardPop takes a secret key and is exported only from the restricted keystore entry: the agent
// path signs through KeyStore.signCardPop, which first checks the card is its own (cardPopSnapshot).
// Errors are fixed sentences that never contain an input (I-7).
import {
  agentCardJcsHash,
  parseAgentCard,
  verifyCardAgentSig,
  type AgentCard,
} from './agent-card.js';
import { bip340PublicKey, bip340Sign, bip340Verify } from './bip340.js';
import { equalBytes } from './bytes.js';
import { decodeHex, decodeHex0x, encodeHex0x } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, taggedHash } from './hash.js';
import type { PublicIdentity } from './keys.js';

/** The 32-byte message a `cardPop` signs: taggedHash(TAGS.cardPop, sha256(JCS(card))). */
function cardPopMessage(card: AgentCard): Uint8Array {
  return taggedHash(TAGS.cardPop, agentCardJcsHash(card));
}

const notOwnCard = (): CryptoInputError =>
  new CryptoInputError(
    'invalid_argument',
    'signCardPop: the card must be this agent card at the current key epoch',
  );

/**
 * The card a KeyStore may sign a `cardPop` for (04 §2.9): the card parses strictly and names
 * exactly `identity`, the store's own keys at its current epoch (agentEvm, agentNostr, agentEnc and
 * keyEpoch). Returns the parsed, frozen card; anything else is CryptoInputError `invalid_argument`
 * with one fixed message, so a KeyStore never names another key, agent or epoch as its own.
 */
export function cardPopSnapshot(card: unknown, identity: PublicIdentity): AgentCard {
  let parsed: AgentCard;
  try {
    parsed = parseAgentCard(card);
  } catch {
    throw notOwnCard();
  }
  if (
    parsed.agentEvm !== identity.agentId ||
    parsed.keyEpoch !== identity.keyEpoch ||
    parsed.agentNostr !== encodeHex0x(identity.agentNostr) ||
    parsed.agentEnc !== encodeHex0x(identity.agentEnc)
  ) {
    throw notOwnCard();
  }
  return parsed;
}

/**
 * `cardPop` (04 §2.9): BIP-340 (64 bytes) by `secretKey` over taggedHash(TAGS.cardPop,
 * sha256(JCS(card))). Refuses a card that does not parse and a key that is not the card's
 * `agentNostr`. For KeyStore implementations only (the restricted keystore entry); the agent signs
 * through KeyStore.signCardPop. `auxRand` is for test vectors only.
 */
export function signCardPop(
  secretKey: Uint8Array,
  card: unknown,
  auxRand?: Uint8Array,
): Uint8Array {
  let parsed: AgentCard;
  try {
    parsed = parseAgentCard(card);
  } catch {
    throw notOwnCard();
  }
  if (!equalBytes(bip340PublicKey(secretKey), decodeHex0x(parsed.agentNostr, { length: 32 }))) {
    throw notOwnCard();
  }
  return bip340Sign(secretKey, cardPopMessage(parsed), auxRand);
}

/**
 * True when the card parses and `cardPop` (128 lowercase hex, no `0x`) is a BIP-340 signature by
 * the card's `agentNostr` over this card under the card-pop tag. False for anything else; it never
 * throws on untrusted input.
 */
export function verifyCardPop(card: unknown, cardPop: unknown): boolean {
  try {
    const parsed = parseAgentCard(card);
    if (typeof cardPop !== 'string') return false;
    return bip340Verify(
      decodeHex0x(parsed.agentNostr, { length: 32 }),
      cardPopMessage(parsed),
      decodeHex(cardPop, { length: 64 }),
    );
  } catch {
    return false;
  }
}

/**
 * The card's proof of possession (04 §2.9, 07 §8): `cardAgentSig` by `agentEvm` and `cardPop` by
 * `agentNostr`, both over this card. Never throws: any failure is false.
 */
export function verifyCardPossession(
  card: unknown,
  cardAgentSig: unknown,
  cardPop: unknown,
): boolean {
  return verifyCardAgentSig(card, cardAgentSig) && verifyCardPop(card, cardPop);
}
