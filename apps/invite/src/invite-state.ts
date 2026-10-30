// What the invite page shows for a URL fragment (04 §3.6, 06 §2.1, 08 §4; I-2, I-5). The fragment is
// hostile input and is read in the browser only. This module stores nothing. Its only request is
// for a short link (D-139, 04 §3.6.2): core derives lookupId and the key from the fragment and calls
// the page's fetcher once with lookupId; the key, the link and the decrypted invite never leave.
//
// Steps, each failing closed to a state that carries nothing from the payload beyond the restricted
// name:
//  1. Bound the input before any parsing (a fragment over the payload limit is `oversized`).
//  2. A short link (`2.<43>`) is resolved first: one GET of the invite object, decrypted in the
//     page (404 `unavailable`, a failed fetch `unreachable`, anything else damaged).
//     Decode with the one codec of @4thtech-io/core: strict base64url, bounded inflation, exact
//     stream end, strict UTF-8, I-JSON and the strict invite schema (which fixes the version).
//  3. The card commits to the name: a `nameHash` mismatch is damaged.
//  4. Check the expiry the invite carries (advisory; the inviter enforces its own, 04 §3.6). An
//     expired invite shows only the restricted name ("Ask {name} for a new one.").
//  5. U3-invite (08 §4): rebuild the canonical link from the checked fragment (for a short link,
//     the short link itself, never the resolved invite) with the page's own prefix, and build the command and the sentence only when it matches the strict pattern. The
//     command is left out above MAX_COMMAND_CHARS (only the sentence is offered then).
import {
  CoreError,
  INVITE_MAX_PAYLOAD_CHARS,
  decodeInviteLink,
  restrictName,
  type ShortInviteFetch,
} from '@4thtech-io/core';
import {
  agentCardNameHash,
  decodeHex0x,
  encodeHex0x,
  formatFingerprint,
  ownerFingerprint,
} from '@4thtech-io/crypto';
import type { Invite } from '@4thtech-io/types';
import { CANONICAL_PREFIX, buildAskAi, buildJoinCommand, isCanonicalLink } from './prompt.js';

/** The inviter's details. Every value is shown with `textContent` only. */
export interface Inviter {
  /** The restricted name (06 §2.1), without quotes. */
  readonly name: string;
  /** True when the name rule fell back to "Contact" plus the fingerprint: say "Someone". */
  readonly fallback: boolean;
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
  /** A short link whose invite object is gone (404: expired, used, cancelled or never existed). */
  | { readonly kind: 'unavailable' }
  /** A short link whose invite object could not be fetched (network, 429, 503, timeout). */
  | { readonly kind: 'unreachable' }
  /** `name`: the restricted name, absent on the name rule's fallback ("the person who sent it"). */
  | { readonly kind: 'expired'; readonly name?: string }
  | {
      readonly kind: 'ready';
      readonly inviteUrl: string;
      /** The command, or undefined when it would be too long for cmd.exe (08 §4). */
      readonly command: string | undefined;
      readonly sentence: string;
      readonly inviter: Inviter;
    };

const DAMAGED: InviteView = { kind: 'damaged' };

/**
 * `hash` is `location.hash` (with its `#`) or the bare payload; `nowSeconds` is the current time.
 * `fetchObject` fetches a short link's invite object (drop-fetch.ts); without it a short link is
 * damaged, as before D-139.
 */
export async function evaluateFragment(
  hash: string,
  nowSeconds: number,
  fetchObject?: ShortInviteFetch,
): Promise<InviteView> {
  const payload = hash.startsWith('#') ? hash.slice(1) : hash;
  if (payload === '') return { kind: 'none' };
  if (payload.length > INVITE_MAX_PAYLOAD_CHARS) return { kind: 'oversized' };
  try {
    let invite: Invite;
    try {
      invite = await decodeInviteLink(
        payload,
        fetchObject === undefined ? {} : { fetchShortInvite: fetchObject },
      );
    } catch (error) {
      if (error instanceof CoreError && error.code === 'invite_unavailable') {
        return { kind: 'unavailable' };
      }
      if (error instanceof CoreError && error.code === 'invite_fetch_failed') {
        return { kind: 'unreachable' };
      }
      return DAMAGED;
    }
    // The card commits to the name (04 §2.4, §3.6): recompute keccak256 over the name exactly as
    // received (not the restricted name shown) and compare with the card's `nameHash`. A mismatch
    // means the name was swapped after the card was made: damaged, and no command.
    if (encodeHex0x(agentCardNameHash(invite.name)) !== invite.card.nameHash) return DAMAGED;
    const digest = ownerFingerprint(
      decodeHex0x(invite.card.ownerEvm, { length: 20 }),
      decodeHex0x(invite.card.ownerNostr, { length: 32 }),
      decodeHex0x(invite.card.ownerEnc, { length: 32 }),
    );
    const fingerprint = formatFingerprint(digest, 'short');
    const name = restrictName(invite.name, fingerprint);
    const fallback = name === restrictName(undefined, fingerprint);
    if (invite.expiresAt <= nowSeconds) {
      return fallback ? { kind: 'expired' } : { kind: 'expired', name };
    }
    // The link is rebuilt from the page's own prefix and the checked payload, never taken from the
    // address bar, and must match the strict pattern before any text is built (08 §4). For a short
    // link that is the short link itself: the command never carries the resolved invite.
    const inviteUrl = `${CANONICAL_PREFIX}${payload}`;
    if (!isCanonicalLink(inviteUrl)) return DAMAGED;
    return {
      kind: 'ready',
      inviteUrl,
      command: buildJoinCommand(inviteUrl),
      sentence: buildAskAi(inviteUrl),
      inviter: { name, fallback, label: 'self-declared', fingerprint, expiresAt: invite.expiresAt },
    };
  } catch {
    // One fixed outcome, with no payload text and no parse detail (I-5).
    return DAMAGED;
  }
}
