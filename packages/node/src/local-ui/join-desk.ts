// U3-invite: the app host's waiting invite (08 §4 "One step from an invite link"; 04 §3.6, §3.6.1;
// b11 §33.2; I-2, I-4, I-5, I-7).
//
// One waiting invite per app host, held in this process's memory only: never on disk, in
// `app.json`, `app-host.json`, the store, a URL of the app, a title, a notification, Activity, a log
// or an error, and never sent to a 4thTech service. It arrives either from `agentlink join` starting
// this host (`AppHostOptions.waitingInvite`) or through the one loopback handoff
// (`POST /api/ui/join/handoff`, approval-server.ts handoffGate). Either way core's Accept step 1
// (`checkInviteLink`: the one D-69 codec, schema, expiry, both card signatures, name and relays, the
// relay URL rule) runs here first; a link that fails it is never stored.
//
// The join screen reads only `view()`: the state, the public `inviteId` (16 bytes, never the
// `secret`), the name-rule name with its Self-declared label, the short owner fingerprint and the
// expiry. Never the link or any other invite field. Accepting (api/join.ts) takes the link with the
// `inviteId` the screen showed: a different one is `invite_changed` and nothing is signed. After a
// started accept the link is dropped; only the display fields stay, to follow the pairing to
// "Connected". While an invite is shown (waiting, not expired), a new one is refused with
// `invite_waiting`; it is replaced only after "Not now" (`dismiss`) or its expiry.
import { checkInviteLink, CoreError, type CheckedInviteLink } from '@4thtech-io/core';
import type { LocalUiReadClient } from './context.js';

/** What the join screen may show of the inviter (11 §5.2, §6.5). Plain text only. */
export interface JoinInviter {
  /** The contact-name rule output (06 §2.1). */
  readonly name: string;
  readonly label: 'self-declared';
  /** The short owner fingerprint (04 §2.9). */
  readonly fingerprint: string;
}

export type JoinState =
  | 'none'
  | 'waiting'
  | 'expired'
  | 'own'
  | 'already_accepted'
  | 'connecting'
  | 'waiting_for_them'
  | 'connected';

/** `GET /api/ui/join` (08 §4): never the link, the payload or any other invite field. */
export interface JoinView {
  readonly state: JoinState;
  readonly inviteId?: string;
  readonly inviter?: JoinInviter;
  /** RFC 3339 UTC, no fraction. */
  readonly expiresAt?: string;
  /**
   * W4-PEOPLE-INVITE: only when `connected`, the new contact's ref (its lower-case ID, as the
   * contacts routes take it), so the screen reads that contact's safety code and no other.
   */
  readonly contactRef?: string;
}

export type JoinOffer = 'stored' | 'invite_waiting' | 'invalid_invite' | 'expired';

type Phase = 'waiting' | 'connecting' | 'waiting_for_them';

interface Held {
  /** The canonical link: the invite secret. Dropped once an accept started (I-7). */
  link: string | undefined;
  readonly inviteId: string;
  /** The inviter's agent ID (the contact ID it becomes). */
  readonly contactId: string;
  readonly inviter: JoinInviter;
  /** Unix seconds (advisory on this side, 04 §3.6). */
  readonly expiresAt: number;
  phase: Phase;
}

/** The longest link the handoff and `join` take: 04 §3.6's payload cap after the fixed prefix. */
const CANONICAL_LINK = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]{1,21846}$/;
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;
/** A contact's ref as the contacts routes take it (api/contacts.ts REF). */
const CONTACT_REF = /^0x[0-9a-f]{40}$/;
const MAX_NAME_CHARS = 128;

/** True for the canonical invite link of 08 §4, and nothing else (no bare payload here). */
export const isCanonicalInviteLink = (link: unknown): link is string =>
  typeof link === 'string' && CANONICAL_LINK.test(link);

/** RFC 3339 in UTC, no fraction. */
const rfc3339 = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The inviter as the screen may show it; undefined for anything malformed (fail closed). */
function inviterOf(checked: CheckedInviteLink): JoinInviter | undefined {
  const name: unknown = checked.contact.display.name;
  const short: unknown = checked.contact.ownerFingerprint.short;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  if (typeof short !== 'string' || !FINGERPRINT.test(short)) return undefined;
  return Object.freeze({ name, label: 'self-declared', fingerprint: short });
}

/** Accept step 1 (core checkInviteLink); a test seam only. */
export type JoinCheck = (link: string, nowSeconds: number) => Promise<CheckedInviteLink>;

export class JoinDesk {
  readonly #nowMs: () => number;
  readonly #check: JoinCheck;
  #held: Held | undefined;

  constructor(nowMs: () => number, check: JoinCheck = checkInviteLink) {
    this.#nowMs = nowMs;
    this.#check = check;
  }

  #nowSeconds(): number {
    return Math.floor(this.#nowMs() / 1000);
  }

  /**
   * True while an invite is shown: waiting for the owner and not expired, or being accepted right
   * now (IR-U3-invite-SEC-4 (a): a handoff never replaces an invite while its accept is in flight).
   */
  shown(): boolean {
    const held = this.#held;
    if (held === undefined) return false;
    if (held.phase === 'connecting') return true;
    return held.phase === 'waiting' && held.expiresAt > this.#nowSeconds();
  }

  /**
   * Stores `link` as the waiting invite after Accept step 1, or refuses it. Nothing is signed,
   * written or sent. Refused while another invite is shown (`invite_waiting`).
   */
  async offer(link: unknown): Promise<JoinOffer> {
    if (!isCanonicalInviteLink(link)) return 'invalid_invite';
    if (this.shown()) return 'invite_waiting';
    let checked: CheckedInviteLink;
    try {
      checked = await this.#check(link, this.#nowSeconds());
    } catch (error) {
      if (error instanceof CoreError && error.code === 'invite_expired') return 'expired';
      return 'invalid_invite';
    }
    const inviter = inviterOf(checked);
    if (inviter === undefined) return 'invalid_invite';
    // Checked again after the await: a concurrent offer may have won.
    if (this.shown()) return 'invite_waiting';
    this.#held = {
      link,
      inviteId: checked.inviteId,
      contactId: checked.contact.id.toLowerCase(),
      inviter,
      expiresAt: checked.expiresAt,
      phase: 'waiting',
    };
    return 'stored';
  }

  /** "Not now": forgets the waiting invite (and any pairing being followed). Signs nothing. */
  dismiss(): void {
    if (this.#held !== undefined) this.#held.link = undefined;
    this.#held = undefined;
  }

  /**
   * The link to accept, for the accept route only, when `inviteId` is the shown invite's:
   * `invite_changed` for another ID (or none waiting), `expired` past its expiry. Marks it
   * `connecting` until `settle`.
   */
  take(inviteId: unknown): { readonly link: string } | 'invite_changed' | 'expired' | 'busy' {
    const held = this.#held;
    if (held === undefined || typeof inviteId !== 'string' || inviteId !== held.inviteId) {
      return 'invite_changed';
    }
    if (held.phase !== 'waiting' || held.link === undefined) return 'busy';
    if (held.expiresAt <= this.#nowSeconds()) return 'expired';
    held.phase = 'connecting';
    return { link: held.link };
  }

  /** After the accept route: `started` drops the link and follows the pairing; else back to waiting. */
  settle(inviteId: string, started: boolean): void {
    const held = this.#held;
    if (held === undefined || held.inviteId !== inviteId || held.phase !== 'connecting') return;
    if (started) {
      held.link = undefined;
      held.phase = 'waiting_for_them';
    } else {
      held.phase = 'waiting';
    }
  }

  /** What the join screen shows, for the open agent (`client`; undefined when none is open). */
  async view(client: LocalUiReadClient | undefined): Promise<JoinView> {
    const held = this.#held;
    if (held === undefined) return Object.freeze({ state: 'none' });
    const base = {
      inviteId: held.inviteId,
      inviter: held.inviter,
      expiresAt: rfc3339(held.expiresAt),
    };
    const own = client !== undefined && client.agentId.toLowerCase() === held.contactId;
    let contact = false;
    if (client !== undefined && !own) {
      try {
        contact = (await client.contacts.list()).some(
          (c) => c.id.toLowerCase() === held.contactId && c.status !== 'removed',
        );
      } catch {
        contact = false;
      }
    }
    let state: JoinState;
    if (held.phase === 'connecting') state = 'connecting';
    else if (held.phase === 'waiting_for_them') state = contact ? 'connected' : 'waiting_for_them';
    else if (own) state = 'own';
    else if (contact) state = 'already_accepted';
    else if (held.expiresAt <= this.#nowSeconds()) state = 'expired';
    else state = 'waiting';
    const ref =
      state === 'connected' && CONTACT_REF.test(held.contactId) ? held.contactId : undefined;
    return Object.freeze({ state, ...base, ...(ref === undefined ? {} : { contactRef: ref }) });
  }
}
