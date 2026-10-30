// The pairing protocol (04 §3.6, §3.6.1, §3.4.1, §2.9; 07 §4.3; 06 §2.1; M1-7c).
//
// - createInvite (A): a single-use invite with a fresh inviteId, secret and nonceA. A stores
//   {inviteId, proofKey, nonceA, label, expiresAt, used} with proofKey and nonceA encrypted at rest
//   and never the raw secret. The secret travels only in the link it returns.
// - acceptInvite (B): decodes the link (the one codec, invite-link.ts), checks the strict schema,
//   expiry, cardSig, cardAgentSig (and agentEvm != ownerEvm), the name and relays against the card,
//   then applies `contacts.acceptInvites`: by default it returns `pending_approval` and changes
//   nothing. Once allowed, it stages the pairing and stores its `handshake` (proof, nonceB, the
//   copied codeCommit and inviterCardHash) in one store transaction; the handshake `id` is the
//   pairing ID, which binds the completion evidence to this pairing.
// - A, on a `handshake` from the card's own key for an unused, unexpired invite with a valid proof:
//   marks the invite used, stores the handshake, its `handshake-ack` (revealing nonceA) and the
//   contact in one store transaction. A second valid answer is refused and reported (`invite_used`).
// - B, on a `handshake-ack` from the invite card's key that matches its handshake, the invite card
//   and relays, and whose codeReveal opens codeCommit: stores it and completes, in one transaction.
//   A reveal that does not open leaves the pairing pending and reports `safety_commit_mismatch`.
// - Both completions verify the pair as a 04 §3.6.1 transcript first (safety-code.ts), so the
//   stored pair always yields the code. The code is recomputed from the signed envelopes on every
//   display (ownerSafetyCode) and never returned by any other method.
//
// I-1, I-5, I-7: no invite secret, proofKey, nonce, link or safety code goes into a log line, an
// error or a report. Errors are fixed sentences. Inbound names are shown only through restrictName.
// I-4: no MCP tool creates or passes a `handshake` or `handshake-ack`; they are built here only.
import {
  agentCardJcsHash,
  canonicalize,
  checkSafetyCodeReveal,
  decodeBase64url,
  derivePairingProofKey,
  encodeBase64url,
  encodeHex,
  formatFingerprint,
  decodeHex,
  generateShortInviteSecret,
  pairingProof,
  randomBytes,
  sealShortInvite,
  safetyCodeCommit,
  verifyCardPop,
  verifyPairingProof,
  wipe,
  type AgentCard,
  type JsonValue,
} from '@4thtech-io/crypto';
import {
  INVITE_DEFAULT_EXPIRY_DAYS,
  type ContactDisplayName,
  type Invite,
  type Payload,
} from '@4thtech-io/types';
import {
  DROP_DEFAULT_ENDPOINT,
  StorageError,
  createDropAdapter,
  fetchInviteObject,
  type DropAdapter,
} from '@4thtech-io/storage';
import { agentNostrKey, checkName, checkReceivedCard, ownerFingerprintHex } from './card.js';
import type { ContactBook, StagedPairing } from './contacts.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import {
  outboundRow,
  sealPairingEnvelope,
  type BuiltEnvelope,
  type InboundPairing,
  type InboundReason,
  type PairingHandler,
  type PairingOutcome,
} from './envelopes.js';
import { CoreError, type CoreErrorCode } from './errors.js';
import type { IdentityService } from './identity.js';
import type { DropConfig } from './files/platform.js';
import {
  clearShortInviteCache,
  decodeInviteLink,
  encodeInviteLink,
  encodeInvitePayload,
  encodeShortInviteLink,
  resolveInviteLink,
  type ShortInviteFetch,
} from './invite-link.js';
import { restrictName } from './names.js';
import { verifyPairingTranscript, type PairingTranscript } from './safety-code.js';
import type { Row } from './store/schema.js';
import { openStoredPairingMessage, recomputeStoredPairing } from './stored-envelope.js';

/** Seconds per day, for invite expiry. */
const DAY_SECONDS = 86_400;
const INVITE_ID_BYTES = 16;
const SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const THREAD_BYTES = 16;

export interface CreateInviteInput {
  /**
   * The agent's label for whom the invite is for. Agent-written, so untrusted (06 §2.1): stored
   * sealed as a suggested alias, shown only restricted until the owner confirms it.
   */
  readonly label?: string;
  /** Whole days, 1 to 7 (default 7, 04 §3.6). */
  readonly expiresInDays?: number;
  /**
   * W4-SHORT-INVITE (D-139 (7)): the format 1 long link, uploading nothing to the drop. Only the
   * owner's surfaces set it (Advanced in the app, `agentlink invite --long`); no MCP argument does.
   */
  readonly long?: boolean;
}

export interface CreatedInvite {
  /**
   * W4-PEOPLE-INVITE: the invite's public 16-byte ID (base64url), as `openInvites` lists it and
   * `cancelInvite` takes it. Never the secret.
   */
  readonly inviteId: string;
  /** The link to share. It carries the invite secret: never log it (I-7). */
  readonly inviteUrl: string;
  /**
   * W4-SHORT-INVITE: `short` (link format 2, the invite on the drop) or `long` (format 1: asked for,
   * no drop configured, or the automatic fallback when the drop refused or could not be reached).
   */
  readonly format: 'short' | 'long';
  /** The inviter's own owner fingerprint (06 §2.1): display only. */
  readonly ownerFingerprint: { readonly short: string; readonly long: string };
  readonly expiresAt: number;
}

/** The counterparty of a pairing that has not completed, as an approval or a result shows it. */
export interface PendingContact {
  readonly id: string;
  readonly display: ContactDisplayName;
  readonly ownerFingerprint: { readonly short: string; readonly long: string };
  readonly pairing: 'pending';
  readonly safetyCodeChecked: false;
}

export interface AcceptInviteInput {
  /** The full canonical link or the bare payload. Untrusted (I-5). */
  readonly link: string;
  /**
   * True only when `contacts.acceptInvites` allows it: the policy rule is `auto`, or the owner
   * approved this pairing through a verified owner decision (M1-7d, M1-7e). No MCP argument sets it
   * (I-4). Default false: the result is `pending_approval` and nothing changes.
   */
  readonly allowed?: boolean;
}

export type AcceptInviteResult =
  | { readonly status: 'pending_approval'; readonly contact: PendingContact }
  | {
      readonly status: 'pending';
      readonly contact: PendingContact;
      readonly pairingId: string;
      /** The stored, signed handshake to publish (07 §3.2). */
      readonly handshake: BuiltEnvelope;
    };

/**
 * The safety code for an owner surface only (the local app, the desktop app, `agentlink contacts
 * --verify` in the owner's terminal; 04 §3.6.1). Never put it in a tool result, a log line or an
 * error. `unavailable` shows "Can't show the safety code".
 */
export type OwnerSafetyCode =
  | { readonly status: 'ok'; readonly code: string; readonly pairingDigest: string }
  | { readonly status: 'unavailable'; readonly reason: 'not_paired' | 'invalid' | 'conflict' };

/** Card errors make a pairing message invalid; rule errors make it refused (04 §2.9, §3.6). */
const RULE_ERRORS: ReadonlySet<CoreErrorCode> = new Set([
  'contact_is_self',
  'contact_revoked',
  'contact_conflict',
  'repair_owner_changed',
  'repair_epoch_lower',
]);

/**
 * `work`, or a rejection once `ms` have passed (and `abort` is aborted, so the guarded fetch gives
 * the request up too). A late outcome of `work` is ignored.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, abort: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('deadline'));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function classify(error: unknown, contactId: string | undefined): PairingOutcome {
  if (!(error instanceof CoreError) || error.code === 'store_unreadable') throw error;
  const contact = contactId === undefined ? {} : { contactId };
  if (error.code === 'pairing_expired')
    return { kind: 'drop', reason: 'invite_expired', ...contact };
  if (RULE_ERRORS.has(error.code)) {
    return { kind: 'refuse', reason: 'pairing_refused', ...contact, flagged: false };
  }
  return { kind: 'drop', reason: 'pairing_invalid', ...contact };
}

const drop = (reason: InboundReason, contactId?: string): PairingOutcome => ({
  kind: 'drop',
  reason,
  ...(contactId === undefined ? {} : { contactId }),
});

function fingerprintOf(card: AgentCard): { readonly short: string; readonly long: string } {
  const long = ownerFingerprintHex(card);
  return { short: formatFingerprint(decodeHex(long, { length: 32 }), 'short'), long };
}

function pendingContact(card: AgentCard, name: string): PendingContact {
  const ownerFingerprint = fingerprintOf(card);
  return {
    id: card.agentEvm,
    display: {
      name: restrictName(name, ownerFingerprint.short),
      label: 'self-declared',
      nameSource: 'counterparty',
    },
    ownerFingerprint,
    pairing: 'pending',
    safetyCodeChecked: false,
  };
}

/**
 * U3-invite (08 §4; 06 §8 `agentlink join`): an invite after Accept step 1 alone (04 §3.6), with no
 * agent open. `inviteId` is the invite's public 16-byte ID (never its secret); `contact` is who it
 * names under the contact-name rule. Nothing is stored, signed or sent.
 */
export interface CheckedInviteLink {
  readonly inviteId: string;
  readonly contact: PendingContact;
  readonly expiresAt: number;
}

interface StepOne {
  readonly invite: Invite;
  readonly checked: ReturnType<typeof checkReceivedCard>;
  readonly contact: PendingContact;
}

/** W4-INVITES-LIST (08 §1): one open invite as the owner's list shows it; never the link. */
export interface OpenInvite {
  /** The invite's public 16-byte ID (base64url): what Cancel names. Not a secret on its own. */
  readonly inviteId: string;
  /** The name the invite was created for (06 §2.1: a suggested alias), or null. */
  readonly label: string | null;
  readonly expiresAt: number;
}

/** Retry delays for a failed drop object delete (04 §3.6.2: retried with backoff). */
/**
 * O-L1: the short invite upload is given up after this (then the format 1 link), well before the
 * guarded fetch's own 60 s, so Create never waits on a drop that does not answer (04 §3.6.2).
 */
export const INVITE_UPLOAD_TIMEOUT_MS = 10_000;
const DELETE_BACKOFF_BASE_MS = 30_000;
const DELETE_BACKOFF_MAX_MS = 60 * 60 * 1000;

/**
 * The short-invite fetcher over a drop configuration (04 §3.6.2 steps 2-4): the URL is built by
 * the storage client from the configured drop origin and the derived lookup ID only. A 404 is
 * `invite_unavailable`; 429, 503, a timeout or a network failure is `invite_fetch_failed`; a
 * response that is not an invite object is `invite_invalid` ("damaged").
 */
export function shortInviteFetcher(drop: DropConfig | undefined): ShortInviteFetch | undefined {
  if (drop === undefined) return undefined;
  const endpoint = drop.endpoint ?? DROP_DEFAULT_ENDPOINT;
  return async (lookupId) => {
    try {
      return await fetchInviteObject({ endpoint, fetch: drop.fetch }, lookupId);
    } catch (error) {
      const code = error instanceof StorageError ? error.code : undefined;
      if (code === 'not_found') {
        throw new CoreError('invite_unavailable', 'The invite is no longer available.');
      }
      if (code === 'too_large' || code === 'invalid_response' || code === 'invalid_argument') {
        throw new CoreError('invite_invalid', 'The invite link is not valid.');
      }
      throw new CoreError('invite_fetch_failed', 'The invite could not be fetched. Try again.');
    }
  };
}

/**
 * Accept step 1 (04 §3.6): the one D-69 codec and the strict schema, the expiry, both card
 * signatures, the name and relays against the card and the relay URL rule (04 §4). No agent, no
 * store. Throws core's fixed errors only; none carries anything from the link (I-5, I-7).
 */
async function acceptStepOne(
  link: string,
  now: number,
  fetchShortInvite: ShortInviteFetch | undefined,
): Promise<StepOne> {
  const invite = await decodeInviteLink(
    link,
    fetchShortInvite === undefined ? {} : { fetchShortInvite },
  );
  // B's expiry check is advisory (A enforces the expiry it stored, 04 §3.6).
  if (invite.expiresAt <= now) {
    throw new CoreError('invite_expired', 'The invite has expired. Ask for a new one.');
  }
  const checked = checkReceivedCard(
    {
      card: invite.card,
      cardSig: invite.cardSig,
      cardAgentSig: invite.cardAgentSig,
      name: invite.name,
      relays: invite.relays,
    },
    { requireAgentSig: true, now },
  );
  return { invite, checked, contact: pendingContact(checked.card, checked.name) };
}

/**
 * U3-invite: Accept step 1 only, for `agentlink join` and the app host's waiting invite. A format 2
 * link is resolved through `options.drop` (04 §3.6.2), once per process.
 */
export async function checkInviteLink(
  link: string,
  nowSeconds: number,
  options: { readonly drop?: DropConfig } = {},
): Promise<CheckedInviteLink> {
  const { invite, contact } = await acceptStepOne(
    link,
    nowSeconds,
    shortInviteFetcher(options.drop),
  );
  return { inviteId: invite.inviteId, contact, expiresAt: invite.expiresAt };
}

const same = (a: unknown, b: unknown): boolean =>
  canonicalize(a as JsonValue) === canonicalize(b as JsonValue);

export class PairingService implements PairingHandler {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;
  readonly #drop: DropConfig | undefined;
  readonly #fetchShort: ShortInviteFetch | undefined;
  /** Invites whose drop object must go although the invite is open (a fallback after an upload). */
  readonly #orphans = new Set<string>();
  /** Failed deletes: when to try again (memory only; the drop's hard expiry is the backstop). */
  readonly #retry = new Map<string, { failures: number; nextAt: number }>();
  #sweeping: Promise<void> | undefined;

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    contacts: ContactBook,
    drop?: DropConfig,
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
    this.#drop = drop;
    this.#fetchShort = shortInviteFetcher(drop);
  }

  /**
   * W4-SHORT-INVITE: the format 1 link of `link` (itself, or a short link resolved once through
   * this agent's drop; 04 §3.6.2). Surfaces that build the accept approval action call it first, so
   * every surface signs over the same action.
   */
  async resolveInviteLink(link: string): Promise<string> {
    return resolveInviteLink(link, this.#fetchShort);
  }

  #dropAdapter(signal?: AbortSignal): DropAdapter | undefined {
    const drop = this.#drop;
    if (drop === undefined) return undefined;
    const dropFetch = drop.fetch;
    try {
      return createDropAdapter({
        ...(drop.endpoint === undefined ? {} : { endpoint: drop.endpoint }),
        signer: this.#ctx.keyStore,
        fetch:
          signal === undefined
            ? dropFetch
            : (request: Request) => dropFetch(new Request(request, { signal })),
        now: () => new Date(nowOf(this.#ctx) * 1000),
        logger: this.#ctx.log,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * True while a pairing is pending on either side (U3-invite-b, Decision 37; 06 §6): a sent invite
   * not used yet and not expired (the inviter waits for a handshake), or an accept staged and not
   * expired (the invitee waits for the `handshake-ack`). Reads the store only: no sealed column is
   * opened, nothing is written. The app host uses it to follow pairings more often (06 §6).
   */
  async waiting(): Promise<boolean> {
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction(
      (tx) =>
        tx
          .select('invites')
          .some((row) => row.used_at == null && row.cancelled_at == null && row.expires_at > now) ||
        tx.select('pairings').some((row) => row.expires_at > now),
    );
  }

  // --- A: create an invite -----------------------------------------------------------------------

  /** Creates a single-use invite (04 §3.6). Returns the link; stores proofKey, never the secret. */
  async createInvite(input: CreateInviteInput = {}): Promise<CreatedInvite> {
    const ctx = this.#ctx;
    await this.#identity.assertCanSend();
    const days = input.expiresInDays ?? INVITE_DEFAULT_EXPIRY_DAYS;
    if (!Number.isSafeInteger(days) || days < 1 || days > INVITE_DEFAULT_EXPIRY_DAYS) {
      throw new CoreError('invite_options_invalid', 'The invite expiry must be 1 to 7 days.');
    }
    const label = input.label === undefined ? undefined : checkName(input.label);
    const own = await this.#identity.signedCard();
    const now = nowOf(ctx);
    const expiresAt = now + days * DAY_SECONDS;
    const inviteId = randomBytes(INVITE_ID_BYTES);
    const secret = randomBytes(SECRET_BYTES);
    const nonceA = randomBytes(NONCE_BYTES);
    // The upload's requests carry this signal: aborted at the deadline (O-L1).
    const uploadAbort = new AbortController();
    const adapter = input.long === true ? undefined : this.#dropAdapter(uploadAbort.signal);
    let proofKey: Uint8Array | undefined;
    let linkSecret: Uint8Array | undefined;
    try {
      proofKey = derivePairingProofKey(secret);
      const id = encodeBase64url(inviteId);
      const invite: Invite = {
        v: 1,
        inviteId: id,
        secret: encodeBase64url(secret),
        card: own.card as unknown as Invite['card'],
        cardSig: own.cardSig,
        cardAgentSig: own.cardAgentSig,
        codeCommit: encodeBase64url(safetyCodeCommit(inviteId, nonceA)),
        name: own.name,
        relays: [...own.relays],
        expiresAt,
      };
      const longUrl = await encodeInviteLink(invite);
      const key = [id];
      // W4-SHORT-INVITE (04 §3.6.2 Create): seal the payload under a fresh link secret and record
      // the lookup ID and drop key epoch, sealed, before the upload is sent.
      let sealed: { lookupId: string; object: Uint8Array; epoch: number } | undefined;
      if (adapter !== undefined) {
        try {
          const epoch = await adapter.inviteEpoch();
          linkSecret = generateShortInviteSecret();
          const object = await sealShortInvite(linkSecret, await encodeInvitePayload(invite));
          sealed = { lookupId: encodeBase64url(object.lookupId), object: object.object, epoch };
        } catch {
          sealed = undefined; // the key is unavailable: nothing was recorded or sent; long link
        }
      }
      const row: Row<'invites'> = {
        invite_id: id,
        proof_key: await seal(ctx, 'invites', 'proof_key', key, encodeBase64url(proofKey)),
        nonce_a: await seal(ctx, 'invites', 'nonce_a', key, encodeBase64url(nonceA)),
        label: label === undefined ? null : await seal(ctx, 'invites', 'label', key, label),
        expires_at: expiresAt,
        used_at: null,
        created_at: now,
        drop_lookup_id:
          sealed === undefined
            ? null
            : await seal(ctx, 'invites', 'drop_lookup_id', key, sealed.lookupId),
        drop_key_epoch:
          sealed === undefined
            ? null
            : await seal(ctx, 'invites', 'drop_key_epoch', key, String(sealed.epoch)),
        cancelled_at: null,
      };
      await ctx.store.transaction((tx) => {
        tx.insert('invites', row);
      });
      let inviteUrl = longUrl;
      let format: CreatedInvite['format'] = 'long';
      if (sealed !== undefined && adapter !== undefined && linkSecret !== undefined) {
        try {
          await withDeadline(
            adapter.putInvite({
              lookupId: sealed.lookupId,
              object: sealed.object,
              expiresAt: new Date(expiresAt * 1000),
              epoch: sealed.epoch,
            }),
            INVITE_UPLOAD_TIMEOUT_MS,
            uploadAbort,
          );
          inviteUrl = encodeShortInviteLink(linkSecret);
          format = 'short';
        } catch {
          // The drop refused or could not be reached (D-139 (7)): the same invite as a format 1
          // link. The upload's outcome may be ambiguous, so the recorded object is deleted anyway,
          // in the background: the link is returned now (O-L1). The sweep never throws; the catch
          // logs a fixed message only (I-7).
          ctx.log.info('invite drop unavailable, long link');
          this.#orphans.add(id);
          this.sweepInviteObjects().catch(() => {
            ctx.log.info('invite drop sweep failed');
          });
        }
      }
      ctx.log.info('invite created', { expiresAt, format });
      return {
        inviteId: id,
        inviteUrl,
        format,
        ownerFingerprint: fingerprintOf(own.card),
        expiresAt,
      };
    } finally {
      wipe(secret);
      wipe(nonceA);
      if (proofKey !== undefined) wipe(proofKey);
      if (linkSecret !== undefined) wipe(linkSecret);
    }
  }

  // --- A: open invites, cancel, and the drop objects (W4-INVITES-LIST, W4-SHORT-INVITE) ----------

  /**
   * The open invites (not used, not cancelled, not expired), newest first: ID, label and expiry
   * only. Never a link, a secret or a lookup ID (I-1, I-7).
   */
  async openInvites(): Promise<readonly OpenInvite[]> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const rows = await ctx.store.transaction((tx) =>
      tx
        .select('invites')
        .filter((r) => r.used_at == null && r.cancelled_at == null && r.expires_at > now),
    );
    rows.sort((a, b) => b.created_at - a.created_at || (a.invite_id < b.invite_id ? -1 : 1));
    const out: OpenInvite[] = [];
    for (const row of rows) {
      let label: string | null = null;
      if (row.label != null) {
        try {
          label = await open(ctx, 'invites', 'label', [row.invite_id], row.label);
        } catch {
          label = null;
        }
      }
      out.push({ inviteId: row.invite_id, label, expiresAt: row.expires_at });
    }
    return out;
  }

  /**
   * Cancels an open invite (04 §3.6.2: an owner action on the local page or the CLI; no MCP tool
   * cancels). A later answer is refused, and a short link's drop object is deleted (retried with
   * backoff; never blocking). `not_found` for an unknown, used, cancelled or expired invite.
   */
  async cancelInvite(inviteId: string): Promise<'cancelled' | 'not_found'> {
    const ctx = this.#ctx;
    if (typeof inviteId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(inviteId)) return 'not_found';
    const now = nowOf(ctx);
    const done = await ctx.store.transaction((tx) => {
      const row = tx.get('invites', { invite_id: inviteId });
      if (
        row === undefined ||
        row.used_at != null ||
        row.cancelled_at != null ||
        row.expires_at <= now
      ) {
        return false;
      }
      tx.update('invites', { invite_id: inviteId, cancelled_at: null }, { cancelled_at: now });
      return true;
    });
    if (!done) return 'not_found';
    ctx.log.info('invite cancelled');
    await this.sweepInviteObjects();
    return 'cancelled';
  }

  /**
   * Deletes the drop object of every short invite that completed, was cancelled or expired (and of
   * a fallback whose upload outcome was ambiguous), with a DELETE signed at the recorded epoch. A
   * deleted object's columns are cleared. A failure is retried later with backoff; nothing here
   * throws or blocks a pairing (04 §3.6.2). The host calls it now and then (06 §6 follow).
   */
  async sweepInviteObjects(): Promise<void> {
    if (this.#sweeping !== undefined) return this.#sweeping;
    this.#sweeping = this.#sweep().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<void> {
    const ctx = this.#ctx;
    const adapter = this.#dropAdapter();
    if (adapter === undefined) return;
    const now = nowOf(ctx);
    const nowMs = now * 1000;
    let rows: Row<'invites'>[];
    try {
      rows = await ctx.store.transaction((tx) =>
        tx
          .select('invites')
          .filter(
            (r) =>
              r.drop_lookup_id != null &&
              (r.used_at != null ||
                r.cancelled_at != null ||
                r.expires_at <= now ||
                this.#orphans.has(r.invite_id)),
          ),
      );
    } catch {
      return;
    }
    for (const row of rows) {
      const id = row.invite_id;
      const wait = this.#retry.get(id);
      if (wait !== undefined && wait.nextAt > nowMs) continue;
      try {
        const key = [id];
        const lookupId = await open(ctx, 'invites', 'drop_lookup_id', key, row.drop_lookup_id!);
        const epochText = await open(ctx, 'invites', 'drop_key_epoch', key, row.drop_key_epoch!);
        await adapter.deleteInvite(lookupId, Number(epochText));
        await ctx.store.transaction((tx) => {
          tx.update('invites', { invite_id: id }, { drop_lookup_id: null, drop_key_epoch: null });
        });
        this.#orphans.delete(id);
        this.#retry.delete(id);
        ctx.log.debug('invite drop object deleted');
      } catch {
        const failures = (wait?.failures ?? 0) + 1;
        const delay = Math.min(DELETE_BACKOFF_BASE_MS * 2 ** (failures - 1), DELETE_BACKOFF_MAX_MS);
        this.#retry.set(id, { failures, nextAt: nowMs + delay });
        ctx.log.info('invite drop object delete failed', { failures });
      }
    }
  }

  // --- B: accept an invite -----------------------------------------------------------------------

  /**
   * Accepts an invite (04 §3.6 Accept). Step 1 always runs. Unless `allowed`, the result is
   * `pending_approval` (the default `contacts.acceptInvites: approval`) and nothing is stored. Once
   * allowed, the pairing is staged and its `handshake` stored in one transaction, ready to publish;
   * the pairing stays `pending` until the inviter's verified `handshake-ack`.
   */
  async acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    // Step 1, shared with checkInviteLink (one implementation for every surface).
    const { invite, checked, contact } = await acceptStepOne(input.link, now, this.#fetchShort);
    const self = await ctx.keyStore.getPublicBundle();
    if (checked.card.agentEvm === self.agentId) {
      throw new CoreError('contact_is_self', 'An agent cannot add itself as a contact.');
    }
    await this.#identity.assertCanSend();
    if (input.allowed !== true) return { status: 'pending_approval', contact };

    const prepared = await this.#contacts.prepareStage({
      card: invite.card,
      cardSig: invite.cardSig,
      cardAgentSig: invite.cardAgentSig,
      name: invite.name,
      relays: invite.relays,
      role: 'invitee',
      expiresAt: invite.expiresAt,
    });
    // M1-9ze: the counterparty staged (and sealed to, below) must be the contact this invite names,
    // the one step 1 verified and the approval showed. M1-9zf: that binds the owner too (step 2
    // shows the owner fingerprint) and the whole card, by its sha256(JCS) hash, so a card with the
    // same contact id but another owner, keys or epoch is refused. Anything else is refused before
    // any write, with the fixed invite error: no inbound text or key material in it (I-2, I-5).
    const staged = prepared.staged.card;
    if (
      staged.agentEvm !== contact.id ||
      agentNostrKey(staged) !== agentNostrKey(checked.card) ||
      ownerFingerprintHex(staged) !== contact.ownerFingerprint.long ||
      encodeHex(agentCardJcsHash(staged)) !== encodeHex(agentCardJcsHash(checked.card))
    ) {
      throw new CoreError('invite_invalid', 'The invite link is not valid.');
    }
    const { pairingId } = prepared.staged;
    const own = await this.#identity.signedCard();
    const inviteId = decodeBase64url(invite.inviteId, { length: INVITE_ID_BYTES });
    const secret = decodeBase64url(invite.secret, { length: SECRET_BYTES });
    const nonceB = randomBytes(NONCE_BYTES);
    let proofKey: Uint8Array | undefined;
    let proof: Uint8Array | undefined;
    try {
      proofKey = derivePairingProofKey(secret);
      proof = pairingProof(proofKey, inviteId, own.card);
      const payload = {
        type: 'handshake',
        body: {
          inviteId: invite.inviteId,
          card: own.card,
          cardSig: own.cardSig,
          cardAgentSig: own.cardAgentSig,
          // 04 §2.9, §3.6 (D-102): B's proof of possession travels with its card.
          cardPop: own.cardPop,
          name: own.name,
          relays: [...own.relays],
          proof: encodeBase64url(proof),
          codeNonce: encodeBase64url(nonceB),
          codeCommit: invite.codeCommit,
          inviterCardHash: encodeHex(agentCardJcsHash(invite.card)),
        },
        replyTo: null,
        files: [],
      };
      const sealed = await sealPairingEnvelope(ctx, this.#identity, {
        payload,
        peer: checked.card,
        thread: encodeBase64url(randomBytes(THREAD_BYTES)),
        id: decodeBase64url(pairingId, { length: INVITE_ID_BYTES }),
      });
      const row = await outboundRow(ctx, sealed, null);
      await ctx.store.transaction((tx) => {
        prepared.apply(tx);
        tx.insert('envelopes', row);
      });
      ctx.log.info('pairing started', { role: 'invitee' });
      // F-L1: the resolved link (it carries the pairing secret) is not kept after a used accept.
      clearShortInviteCache(input.link);
      return {
        status: 'pending',
        contact,
        pairingId,
        handshake: {
          envelope: sealed.envelope,
          envelopeHash: sealed.envelopeHash,
          thread: sealed.thread,
          recipientNostrKeys: sealed.recipientNostrKeys,
        },
      };
    } finally {
      wipe(secret);
      wipe(nonceB);
      if (proofKey !== undefined) wipe(proofKey);
      if (proof !== undefined) wipe(proof);
    }
  }

  // --- Owner surfaces: the safety code -----------------------------------------------------------

  /**
   * Recomputes the safety code of a completed pairing from its stored, signed `handshake` and
   * `handshake-ack` (04 §3.6.1 steps 1-5), opened with the agent's own key, against the contact's
   * current card. Never from a stored code, digest or column. Two different handshakes, or two
   * different acks, stored for the pairing's invite give no code (`conflict`). For owner surfaces
   * only: never in a tool result (06 §2.1).
   */
  async ownerSafetyCode(contactId: string): Promise<OwnerSafetyCode> {
    let card: AgentCard;
    try {
      card = (await this.#contacts.get(contactId)).card;
    } catch (error) {
      if (error instanceof CoreError && error.code === 'contact_not_found') {
        return { status: 'unavailable', reason: 'not_paired' };
      }
      throw error;
    }
    const result = await recomputeStoredPairing(this.#ctx, contactId, card);
    return result.status === 'ok'
      ? { status: 'ok', code: result.code, pairingDigest: result.pairingDigest }
      : result;
  }

  // --- Inbound (PairingHandler, called by EnvelopeService.processReceived) ----------------------

  /**
   * Before step 8: a `handshake` must name an invite this agent holds, and a `handshake-ack` a
   * pairing in progress from its sender's key. Anything else is dropped with nothing stored.
   */
  screen(
    tx: Parameters<PairingHandler['screen']>[0],
    payload: Payload,
    from: string,
  ): InboundReason | undefined {
    if (payload.type === 'handshake') {
      return tx.get('invites', { invite_id: payload.body.inviteId }) === undefined
        ? 'invite_unknown'
        : undefined;
    }
    if (payload.type === 'handshake-ack') {
      const staged = tx.get('pairings', { pairing_id: payload.body.handshakeId });
      return staged?.role === 'invitee' && staged.agent_nostr === from
        ? undefined
        : 'pairing_unknown';
    }
    return 'type_unhandled';
  }

  async handle(inbound: InboundPairing): Promise<PairingOutcome> {
    if (inbound.payload.type === 'handshake') {
      const outcome = await this.#onHandshake(inbound);
      // W4-SHORT-INVITE: a completed invite's drop object goes now (never awaited: a failed DELETE
      // never blocks the pairing; 04 §3.6.2).
      void this.sweepInviteObjects().catch(() => undefined);
      return outcome;
    }
    if (inbound.payload.type === 'handshake-ack') return this.#onAck(inbound);
    return drop('type_unhandled', inbound.contactId);
  }

  /** A, on a `handshake` (04 §3.6 Complete, agent A). */
  async #onHandshake(inbound: InboundPairing): Promise<PairingOutcome> {
    const ctx = this.#ctx;
    const { payload, envelope, contactId } = inbound;
    if (payload.type !== 'handshake') return drop('pairing_invalid', contactId);
    const body = payload.body;
    const invite = await ctx.store.transaction((tx) =>
      tx.get('invites', { invite_id: body.inviteId }),
    );
    if (invite === undefined) return drop('invite_unknown', contactId);
    const key = [invite.invite_id];
    const inviteId = decodeBase64url(invite.invite_id, { length: INVITE_ID_BYTES });

    // The proof: an HMAC under the stored proofKey, compared in constant time.
    const proofKey = decodeBase64url(
      await open(ctx, 'invites', 'proof_key', key, invite.proof_key),
      {
        length: 32,
      },
    );
    let proofOk: boolean;
    try {
      proofOk = verifyPairingProof(
        proofKey,
        inviteId,
        body.card,
        decodeBase64url(body.proof, { length: 32 }),
      );
    } catch {
      proofOk = false;
    } finally {
      wipe(proofKey);
    }
    if (!proofOk) return drop('pairing_invalid', contactId);
    // A second valid answer: the link leaked or someone raced the intended contact (04 §3.6).
    if (invite.used_at !== null) {
      return {
        kind: 'refuse',
        reason: 'invite_used',
        ...(contactId === undefined ? {} : { contactId }),
        flagged: false,
      };
    }
    const now = nowOf(ctx);
    if (invite.expires_at <= now) return drop('invite_expired', contactId);
    // W4-SHORT-INVITE: the owner cancelled it (04 §3.6.2); an answer is refused as for an expiry.
    if (invite.cancelled_at != null) return drop('invite_expired', contactId);
    // The sender is the card's agent (the transport already checked the seal key, 04 §3.5).
    if (envelope.from !== agentNostrKey(body.card as AgentCard)) {
      return drop('pairing_invalid', contactId);
    }
    // inviterCardHash names this agent's invite card; codeCommit is this invite's. The invite card
    // is the current card: an invite outlives no card re-issue (fail closed; see the report).
    const own = await this.#identity.signedCard();
    if (body.inviterCardHash !== encodeHex(agentCardJcsHash(own.card))) {
      return drop('pairing_invalid', contactId);
    }
    if (invite.nonce_a === null) return drop('pairing_invalid', contactId);
    const nonceA = decodeBase64url(await open(ctx, 'invites', 'nonce_a', key, invite.nonce_a), {
      length: NONCE_BYTES,
    });
    try {
      if (body.codeCommit !== encodeBase64url(safetyCodeCommit(inviteId, nonceA))) {
        return drop('pairing_invalid', contactId);
      }
      let staged: Awaited<ReturnType<ContactBook['prepareStage']>>;
      try {
        staged = await this.#contacts.prepareStage({
          card: body.card,
          cardSig: body.cardSig,
          cardAgentSig: body.cardAgentSig,
          // Optional (a peer before M1-4d-d); present and invalid drops the whole handshake.
          ...(body.cardPop === undefined ? {} : { cardPop: body.cardPop }),
          name: body.name,
          relays: body.relays,
          role: 'inviter',
          expiresAt: invite.expires_at,
          pairingId: inbound.envelopeId,
        });
      } catch (error) {
        return classify(error, contactId);
      }
      const ack = await sealPairingEnvelope(ctx, this.#identity, {
        payload: {
          type: 'handshake-ack',
          body: {
            inviteId: body.inviteId,
            handshakeId: inbound.envelopeId,
            handshakeHash: inbound.envelopeHash,
            codeReveal: encodeBase64url(nonceA),
            card: own.card,
            cardSig: own.cardSig,
            relays: [...own.relays],
            // 04 §2.9, §3.4.1 (D-102): A's proof of possession over the invite card.
            cardPop: own.cardPop,
          },
          replyTo: inbound.envelopeId,
          files: [],
        },
        peer: staged.staged.card,
        thread: envelope.thread,
      });
      return await this.#complete(inbound, staged.staged, ack, {
        invite: invite.invite_id,
        stage: staged.apply,
        now,
      });
    } finally {
      wipe(nonceA);
    }
  }

  /** B, on a `handshake-ack` (04 §3.4.1, §3.6.1). */
  async #onAck(inbound: InboundPairing): Promise<PairingOutcome> {
    const ctx = this.#ctx;
    const { payload, envelope, contactId } = inbound;
    if (payload.type !== 'handshake-ack') return drop('pairing_invalid', contactId);
    const body = payload.body;
    let staged: StagedPairing | undefined;
    try {
      staged = await this.#contacts.readStaged(body.handshakeId);
    } catch (error) {
      return classify(error, contactId);
    }
    if (
      staged?.role !== 'invitee' ||
      agentNostrKey(staged.card) !== envelope.from ||
      agentNostrKey(body.card as AgentCard) !== envelope.from
    ) {
      return drop('pairing_unknown', contactId);
    }
    const handshakeRow = await ctx.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: staged.pairingId }),
    );
    if (
      handshakeRow?.type !== 'handshake' ||
      handshakeRow.direction !== 'out' ||
      handshakeRow.envelope_hash !== body.handshakeHash
    ) {
      return drop('pairing_invalid', contactId);
    }
    let handshake;
    try {
      handshake = await openStoredPairingMessage(ctx, handshakeRow.envelope_json);
    } catch {
      return drop('pairing_invalid', contactId);
    }
    if (handshake.payload.type !== 'handshake') return drop('pairing_invalid', contactId);
    const hb = handshake.payload.body;
    // A's card, cardSig and relays exactly as in the invite; the invite and handshake it answers.
    if (
      body.inviteId !== hb.inviteId ||
      !same(body.card, staged.card) ||
      body.cardSig !== staged.cardSig ||
      !same(body.relays, staged.relays)
    ) {
      return drop('pairing_invalid', contactId);
    }
    // The commitment (04 §3.6.1): a reveal that does not open leaves the pairing pending, no code.
    if (
      !checkSafetyCodeReveal(
        decodeBase64url(hb.inviteId, { length: INVITE_ID_BYTES }),
        decodeBase64url(body.codeReveal, { length: NONCE_BYTES }),
        decodeBase64url(hb.codeCommit, { length: NONCE_BYTES }),
      )
    ) {
      return drop('safety_commit_mismatch', contactId);
    }
    // 04 §2.9, §3.4.1 (D-102): A's cardPop, when present, must verify over the invite card (whose
    // cardAgentSig the invite carried); one that does not drops the whole ack, which stays pending.
    let cardPop: string | null = null;
    if (body.cardPop !== undefined) {
      if (staged.cardAgentSig === null || !verifyCardPop(staged.card, body.cardPop)) {
        return drop('pairing_invalid', contactId);
      }
      cardPop = body.cardPop;
    }
    return this.#complete(inbound, { ...staged, cardPop }, undefined, {
      handshake,
      now: nowOf(ctx),
    });
  }

  /**
   * Verifies the transcript, then stores the inbound pairing message (and, for A, marks the invite
   * used, stages the pairing and stores the ack) and completes, all in one store transaction.
   */
  async #complete(
    inbound: InboundPairing,
    staged: StagedPairing,
    ack: Awaited<ReturnType<typeof sealPairingEnvelope>> | undefined,
    context: {
      readonly now: number;
      readonly invite?: string;
      readonly stage?: (tx: Parameters<PairingHandler['screen']>[0]) => void;
      readonly handshake?: Awaited<ReturnType<typeof openStoredPairingMessage>>;
    },
  ): Promise<PairingOutcome> {
    const ctx = this.#ctx;
    const { contactId } = inbound;
    const self = (await ctx.keyStore.getPublicBundle()).agentId;
    const opened = { envelope: inbound.envelope, payload: inbound.payload };
    let transcript: PairingTranscript;
    try {
      transcript = verifyPairingTranscript({
        self,
        contactCard: staged.card,
        handshake:
          ack === undefined ? (context.handshake as NonNullable<typeof context.handshake>) : opened,
        ack: ack === undefined ? opened : { envelope: ack.envelope, payload: ack.payload },
      });
    } catch {
      return drop('pairing_invalid', contactId);
    }
    let completion: Awaited<ReturnType<ContactBook['prepareCompletion']>>;
    try {
      completion = await this.#contacts.prepareCompletion(staged, transcript);
    } catch (error) {
      return classify(error, contactId);
    }
    const id = completion.contactId;
    const inboundRow: Row<'envelopes'> = {
      envelope_id: inbound.envelopeId,
      envelope_hash: inbound.envelopeHash,
      thread_id: inbound.envelope.thread,
      direction: 'in',
      contact_id: id,
      from_key: inbound.envelope.from,
      type: inbound.payload.type,
      state: 'ok',
      refused_reason: null,
      created_at: inbound.envelope.createdAt,
      envelope_json: inbound.envelopeJson,
      payload_json: await seal(
        ctx,
        'envelopes',
        'payload_json',
        [inbound.envelopeId],
        inbound.payloadText,
      ),
      read_at: null,
      delivery: null,
      refused_at: null,
      request_accepted_at: null,
    };
    const ackRow = ack === undefined ? undefined : await outboundRow(ctx, ack, id);
    let result: 'claimed_elsewhere' | 'invite_used' | 'done';
    try {
      result = await ctx.store.transaction((tx) => {
        if (!inbound.claim(tx)) return 'claimed_elsewhere';
        if (context.invite !== undefined) {
          const current = tx.get('invites', { invite_id: context.invite });
          // O-L2: re-checked at commit, so a Cancel after the checks above still refuses it.
          if (
            current === undefined ||
            current.expires_at <= context.now ||
            current.cancelled_at != null
          ) {
            throw new CoreError('pairing_expired', 'The pairing has expired.');
          }
          if (current.used_at !== null) return 'invite_used';
          tx.update(
            'invites',
            { invite_id: context.invite, used_at: null },
            { used_at: context.now },
          );
        }
        inbound.write(tx, inboundRow);
        if (ackRow !== undefined) tx.insert('envelopes', ackRow);
        context.stage?.(tx);
        completion.apply(tx);
        return 'done';
      });
    } catch (error) {
      return classify(error, contactId);
    }
    if (result === 'invite_used') {
      return {
        kind: 'refuse',
        reason: 'invite_used',
        ...(contactId === undefined ? {} : { contactId }),
        flagged: false,
      };
    }
    if (result === 'claimed_elsewhere') return { kind: 'done' };
    ctx.log.info('pairing completed', { role: transcript.role });
    return {
      kind: 'done',
      report: { envelopeId: inbound.envelopeId, outcome: 'ok', contactId: id, flagged: false },
    };
  }
}
