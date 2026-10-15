// The sender code of an unknown sender (04 §2.9, D-72; M1-9c-b): computed here, once, with the crypto
// helper `senderCode`, so the CLI and the MCP surfaces never derive it themselves.
//
// Short form (`2B9E·04D1`) by default. When two unknown senders in one store share the short form
// but are different keys, both are shown in the extended form (`2B9E·04D1·5D0E·88B1`), so the owner
// can tell them apart (04 §2.9 "Collisions"). The code only tells senders apart and authenticates
// nothing; it never comes from anything the sender chose, only from its `from` key.
import { decodeHex, formatFingerprint, senderCode } from '@agentlink/crypto';
import type { StoreTx } from './store/store.js';

const NOSTR_KEY = /^[0-9a-f]{64}$/;

/**
 * The display code of every key in `keys`, collisions resolved among `keys` (distinct keys with the
 * same short form get the extended form). A key that is not 64 lowercase hex is left out.
 */
export function senderCodesFor(keys: Iterable<string>): Map<string, string> {
  const forms = new Map<string, { short: string; extended: string }>();
  for (const key of keys) {
    if (forms.has(key) || !NOSTR_KEY.test(key)) continue;
    const digest = senderCode(decodeHex(key, { length: 32 }));
    forms.set(key, {
      short: formatFingerprint(digest, 'short'),
      extended: formatFingerprint(digest, 'extended'),
    });
  }
  const perShort = new Map<string, number>();
  for (const { short } of forms.values()) perShort.set(short, (perShort.get(short) ?? 0) + 1);
  const codes = new Map<string, string>();
  for (const [key, form] of forms) {
    codes.set(key, (perShort.get(form.short) ?? 0) > 1 ? form.extended : form.short);
  }
  return codes;
}

/**
 * Inside a transaction: the codes of every unknown sender in the store, the keys of queued requests
 * and of refused rows from unknown keys, so a collision is judged against the whole store (04 §2.9).
 */
export function unknownSenderCodesTx(tx: StoreTx): Map<string, string> {
  const rows = [
    ...tx.select('envelopes', { direction: 'in', contact_id: null, state: 'request' }),
    ...tx.select('envelopes', { direction: 'in', contact_id: null, state: 'refused' }),
  ];
  return senderCodesFor(rows.map((r) => r.from_key));
}
