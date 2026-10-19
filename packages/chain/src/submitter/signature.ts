// The submitter's local signature check (07 §7, 04 §7 gas griefing; M1-10a): before any chain
// request, an EOA item's signature must recover to its signer under the item's EIP-712 digest. All
// hashing and recovery is @4thtech-io/crypto's (I-8): the canonical-signature rule of 04 §2.4.1
// refuses a high `s`, v outside {27, 28} and any length other than 65 bytes.
//
// A `false` is not final on its own: a signer with code (an ERC-1271 account, or an EOA with an
// EIP-7702 delegation) is checked by the Notary itself, so the submitter refuses an item only when
// the signature does not match AND the signer has no code (the engine reads the code).
import {
  decodeEcdsaSignature,
  encodeHex0x,
  hashTypedData,
  occV2Domain,
  receiptTypedData,
  recordTypedData,
  recoverEvmAddress,
} from '@4thtech-io/crypto';
import type { SubmitItem } from './wire.js';

/** True when the item's 65-byte signature recovers to its signer for this chain and Notary. */
export function itemSignatureMatches(chainId: number, notary: string, item: SubmitItem): boolean {
  try {
    const domain = occV2Domain(chainId, notary);
    const td =
      item.type === 'record'
        ? recordTypedData(domain, item.record)
        : receiptTypedData(domain, item.receipt);
    const { digest } = hashTypedData(td);
    const signature = decodeEcdsaSignature(item.signature);
    const recovered = encodeHex0x(recoverEvmAddress(digest, signature));
    return recovered === item.signer.toLowerCase();
  } catch {
    return false;
  }
}
