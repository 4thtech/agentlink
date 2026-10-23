// What the invite page shows for a URL fragment (04 §3.6, 06 §2.1, 08 §4; I-2, I-5). The fragment is
// hostile input and is read in the browser only. This module never touches the network or storage.
//
// Steps, each failing closed to a state that carries nothing from the payload:
//  1. Bound the input before any parsing (a fragment over the payload limit is `oversized`).
//  2. Decode with the one codec of @4thtech-io/core: strict base64url, bounded inflation, exact
//     stream end, strict UTF-8, I-JSON and the strict invite schema (which fixes the version).
//  3. Check the expiry the invite carries (advisory; the inviter enforces its own, 04 §3.6).
//  4. Build the view: the inviter's name under the contact-name rule with the Self-declared label,
//     the short owner fingerprint, and the prompt from the official template plus the canonical link
//     rebuilt from the checked payload.
import { INVITE_MAX_PAYLOAD_CHARS, decodeInviteLink, restrictName } from '@4thtech-io/core';
import { decodeHex0x, formatFingerprint, ownerFingerprint } from '@4thtech-io/crypto';
import { CANONICAL_PREFIX, buildPrompt, isCanonicalLink } from './prompt.js';

/** The inviter's details. Every value is shown with `textContent` only. */
export interface Inviter {
  /** The restricted name (06 §2.1), without quotes. */
  readonly name: string;
  /** Always `self-declared`: the page checks no signature and no domain (11 §5.2). */
  readonly label: 'self-declared';
  /** Short owner fingerprint, for example `7F3A·19C2` (04 §2.9). */
  readonly fingerprint: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export type InviteView =
  | { readonly kind: 'none' }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'ready';
      readonly inviteUrl: string;
      readonly prompt: string;
      readonly inviter: Inviter;
    };

const DAMAGED: InviteView = { kind: 'damaged' };

/** `hash` is `location.hash` (with its `#`) or the bare payload; `nowSeconds` is the current time. */
export async function evaluateFragment(hash: string, nowSeconds: number): Promise<InviteView> {
  const payload = hash.startsWith('#') ? hash.slice(1) : hash;
  if (payload === '') return { kind: 'none' };
  if (payload.length > INVITE_MAX_PAYLOAD_CHARS) return { kind: 'oversized' };
  try {
    const invite = await decodeInviteLink(payload);
    if (invite.expiresAt <= nowSeconds) return { kind: 'expired' };
    const inviteUrl = `${CANONICAL_PREFIX}${payload}`;
    if (!isCanonicalLink(inviteUrl)) return DAMAGED;
    const digest = ownerFingerprint(
      decodeHex0x(invite.card.ownerEvm, { length: 20 }),
      decodeHex0x(invite.card.ownerNostr, { length: 32 }),
      decodeHex0x(invite.card.ownerEnc, { length: 32 }),
    );
    const fingerprint = formatFingerprint(digest, 'short');
    return {
      kind: 'ready',
      inviteUrl,
      prompt: buildPrompt(inviteUrl),
      inviter: {
        name: restrictName(invite.name, fingerprint),
        label: 'self-declared',
        fingerprint,
        expiresAt: invite.expiresAt,
      },
    };
  } catch {
    // One fixed outcome, with no payload text and no parse detail (I-5).
    return DAMAGED;
  }
}
