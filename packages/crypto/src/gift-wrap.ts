// NIP-59 gift wrap (04 §3.5, 07 §4.1): a kind 1059 event whose content is the NIP-44 v2 encryption of
// a signed seal (kind 13) to one recipient, signed by a fresh ephemeral key. The ephemeral key is
// created, used and wiped inside this call and never leaves @4thtech-io/crypto (07 §4.1, M1-1g).
// It takes no long-term secret, so it is in the main entry. The rumor, the seal (signed through
// KeyStore.signNostr), the randomised created_at and every unwrap rule are M1-5a.
import { randomBytes } from './random.js';
import { decodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { nip44ConversationKey, nip44EncryptWithKey } from './nip44.js';
import {
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  signNostrEvent,
  signedEventSnapshot,
  verifyNostrEvent,
  type NostrEvent,
} from './nostr-event.js';
import { isSecp256k1SecretKey } from './secp256k1-range.js';
import { wipe } from './wipe.js';

/** A secp256k1 secret key from the CSPRNG; out-of-range draws (probability ~2^-128) are wiped. */
function ephemeralSecretKey(): Uint8Array {
  for (;;) {
    const candidate = randomBytes(32);
    if (isSecp256k1SecretKey(candidate)) return candidate;
    wipe(candidate);
  }
}

/**
 * Wraps `seal` for `recipient` (64 lowercase hex x-only key): kind 1059, tags [["p", recipient]],
 * `created_at` as given (the caller randomises it per NIP-59), content = NIP-44 v2 of the seal's
 * JSON under ephemeral key x recipient, signed by the ephemeral key. Refuses a seal that is not a
 * validly signed kind 13 event, a recipient that is not a key on secp256k1 and a negative or
 * unsafe `createdAt`.
 */
export function createGiftWrap(
  sealEvent: NostrEvent,
  recipient: string,
  createdAt: number,
): NostrEvent {
  // One snapshot of the seal is checked, verified and wrapped, so a getter or Proxy cannot wrap
  // something other than what verified (IR-M1-1g-G2-1 M-1).
  let seal: NostrEvent;
  try {
    seal = signedEventSnapshot(sealEvent);
  } catch {
    throw new CryptoInputError('invalid_argument', 'gift wrap: the seal must be a kind 13 event');
  }
  if (seal.kind !== NOSTR_KIND_SEAL) {
    throw new CryptoInputError('invalid_argument', 'gift wrap: the seal must be a kind 13 event');
  }
  if (!verifyNostrEvent(seal)) {
    throw new CryptoInputError('invalid_argument', 'gift wrap: the seal signature does not verify');
  }
  const recipientKey = decodeHex(recipient, { length: 32 });
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new CryptoInputError(
      'invalid_argument',
      'gift wrap: created_at must be a non-negative integer',
    );
  }
  const content = JSON.stringify({
    id: seal.id,
    pubkey: seal.pubkey,
    created_at: seal.created_at,
    kind: seal.kind,
    tags: seal.tags,
    content: seal.content,
    sig: seal.sig,
  });
  const ephemeral = ephemeralSecretKey();
  let conversationKey: Uint8Array | undefined;
  try {
    conversationKey = nip44ConversationKey(ephemeral, recipientKey);
    return signNostrEvent(ephemeral, {
      kind: NOSTR_KIND_GIFT_WRAP,
      created_at: createdAt,
      tags: [['p', recipient]],
      content: nip44EncryptWithKey(conversationKey, content),
    });
  } finally {
    wipe(ephemeral, conversationKey);
  }
}
