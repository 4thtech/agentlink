// NET-PRECHECK (04 §4; 07 §4.3 "Use your own servers"): the server Test publishes one tiny kind 1059
// event to check that a server takes events from anyone and serves them back. It is signed by a
// throwaway key that is created, used and wiped inside this call, exactly like the gift wrap's
// ephemeral key, so the Test never touches an ID's key, an owner key or the KeyStore. It takes no
// secret, so it is in the main entry. Only kind 1059 can be signed: never an AUTH (NIP-42), a seal,
// a rumor or anything a relay or a contact could take as someone's identity.
import { CryptoInputError } from './errors.js';
import { encodeHex } from './encoding.js';
import { bip340PublicKey } from './bip340.js';
import { ephemeralSecretKey } from './gift-wrap.js';
import {
  NOSTR_KIND_GIFT_WRAP,
  signNostrEvent,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr-event.js';
import { wipe } from './wipe.js';

/**
 * Makes a fresh throwaway key, hands `build` its public key (64 lowercase hex) and signs the kind
 * 1059 event `build` returns with it. The secret key never leaves this function and is wiped before
 * it returns. Refuses any other kind (CryptoInputError).
 */
export function createThrowawayEvent(build: (pubkey: string) => UnsignedNostrEvent): NostrEvent {
  const secretKey = ephemeralSecretKey();
  try {
    const event = build(encodeHex(bip340PublicKey(secretKey)));
    if (typeof event !== 'object' || event === null || event.kind !== NOSTR_KIND_GIFT_WRAP) {
      throw new CryptoInputError('invalid_argument', 'throwaway event: only kind 1059 is signed');
    }
    return signNostrEvent(secretKey, event);
  } finally {
    wipe(secretKey);
  }
}
