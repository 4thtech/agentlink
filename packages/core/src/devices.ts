// DEVICES-INTERIM (04 §2.3.3, 06 §3, 07 §3.5): until one ID can be used on several computers, the
// core notices when this ID is in use on another install and says so; spending limits then apply per
// computer (the on-chain allowance, SEC-ALLOW, is the real fix).
//
// - The install id is a KeyStore item the runtime supplies (as the restore mark): 16 random bytes as
//   32 lowercase hex, created on this computer, never in a recovery kit, never sent to any service,
//   relay or contact, never logged. It is written on each budget ledger row (budget.ts) and in
//   `install_state`.
// - `install_state.since` is when this store became this install's: created here, or opened by an
//   install with another id (a restored snapshot, a copied folder), which starts it afresh.
// - The signal is one the app already receives, so nothing new goes on the wire: the agent's own sent
//   copy (04 §3.2 entry 4) of an envelope this store never wrote. This install writes every envelope
//   before any of its wraps is published (outbox.ts), so its own copies are duplicates (envelopes.ts
//   `receive`); a copy accepted as `sent_copy` was built by another install of this ID. Only a copy
//   whose signed creation time is at or after `since` (set when this install first opens the store),
//   and after the last restore plus the clock-skew allowance, counts: an older copy still on the relays, or one the restored backup did
//   not hold, is this ID's own past, not another computer.
// - The notice holds for OTHER_INSTALL_NOTICE_SECONDS after the newest such copy, and after that
//   until a contact shows this computer's keys are still current (DEVICES-INTERIM-2, devicesView).
// - Informational, never a gate: an id or a restore mark that cannot be read marks nothing; nothing
//   here changes a decision. Residual: a computer that only receives (never sends) is not seen.
import { encodeBase64url } from '@4thtech-io/crypto';
import type { CoreContext } from './context.js';
import { nowOf } from './context.js';
import { readRestoreState, type RestoreState } from './restore-guard.js';
import { SINGLETON_SLOT } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** How long the notice holds after the newest copy from another computer (a week). */
export const OTHER_INSTALL_NOTICE_SECONDS = 7 * 86_400;

/** Clock-skew allowance between two computers (as the restore guard's). */
export const OTHER_INSTALL_SKEW_SECONDS = 300;

/** The install id, a KeyStore item supplied by the runtime. */
export interface InstallIdSource {
  /** This install's id (32 lowercase hex). Rejects when the item cannot be read or kept. */
  read(): Promise<string>;
}

/**
 * What the app and `doctor` show: a flag and a time only. Never the install id, and never the other
 * computer's identity: there is none to show.
 */
export interface DevicesState {
  /** A copy from another computer was seen in the last OTHER_INSTALL_NOTICE_SECONDS. */
  readonly otherInUse: boolean;
  /** The signed creation time of the newest such copy, or null. */
  readonly otherSeenAt: number | null;
}

/** The read-only view behind `client.devices`. No MCP tool reaches it. */
export interface DevicesView {
  state(): Promise<DevicesState>;
}

const INSTALL_ID = /^[0-9a-f]{32}$/;

/** The install id per context: read from its source once (a KeyStore call), then kept. */
const installIds = new WeakMap<CoreContext, Promise<string | undefined>>();

function installIdOf(ctx: CoreContext): Promise<string | undefined> {
  const source = ctx.installId;
  if (source === undefined) return Promise.resolve(undefined);
  let pending = installIds.get(ctx);
  if (pending === undefined) {
    pending = source.read().then(
      (id) => (typeof id === 'string' && INSTALL_ID.test(id) ? id : undefined),
      () => undefined,
    );
    void pending.then((id) => {
      // A read that failed is tried again next time (a locked keychain may open later).
      if (id === undefined) installIds.delete(ctx);
    });
    installIds.set(ctx, pending);
  }
  return pending;
}

/**
 * Makes `install_state` this install's, in its own transaction: created when missing, started afresh
 * when it names another install. When the client opens the store (so `since` is its first open), and
 * again before the transactions that write a budget row or accept a sent copy. Without an install id (no source, or it cannot be read) nothing is written.
 */
export async function ensureInstall(ctx: CoreContext): Promise<void> {
  const id = await installIdOf(ctx);
  if (id === undefined) return;
  const now = nowOf(ctx);
  await ctx.store.transaction((tx) => {
    const row = tx.get('install_state', { slot: SINGLETON_SLOT });
    if (row === undefined) {
      tx.insert('install_state', {
        slot: SINGLETON_SLOT,
        install_id: id,
        since: now,
        other_seen_at: null,
      });
    } else if (row.install_id !== id) {
      tx.update(
        'install_state',
        { slot: SINGLETON_SLOT },
        { install_id: id, since: now, other_seen_at: null },
      );
    }
  });
}

/** The restore state as the sent-copy check needs it; read before its transaction. */
export function sentCopyContext(ctx: CoreContext): Promise<RestoreState> {
  return readRestoreState(ctx);
}

/**
 * Inside the transaction that stores an own sent copy this store never wrote: records it as this ID
 * in use on another computer when it was made after this install started and after the last restore
 * (each with the skew allowance). True when it was recorded.
 */
export function noteSentCopyTx(
  tx: StoreTx,
  input: { readonly createdAt: number; readonly now: number; readonly restore: RestoreState },
): boolean {
  const row = tx.get('install_state', { slot: SINGLETON_SLOT });
  if (row === undefined) return false;
  if (input.restore.status === 'unknown') return false;
  const restoredAt = input.restore.status === 'restored' ? input.restore.restoredAt : 0;
  // `since` is when this store was first opened by this install (AgentLinkClient.create), so every
  // own envelope after it is in this store; the skew allowance applies to the restore only.
  const floor = Math.max(row.since, restoredAt + OTHER_INSTALL_SKEW_SECONDS);
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < floor) return false;
  const at = Math.min(input.createdAt, input.now);
  if (row.other_seen_at !== null && row.other_seen_at >= at) return true;
  tx.update('install_state', { slot: SINGLETON_SLOT }, { other_seen_at: at });
  return true;
}

/** At most this many inbound envelopes are read for the currency check (newest first). */
export const CURRENT_KEYS_CHECK_ROWS = 50;

/**
 * DEVICES-INTERIM-2: whether a contact's verified envelope, signed after `from`, lists `kid` (this
 * computer's current agent `enc` kid) among its recipients. Any row that cannot be read counts as no
 * evidence, so the caller fails closed.
 */
function currentKeysConfirmedTx(tx: StoreTx, kid: string, from: number): boolean {
  const rows = tx.select(
    'envelopes',
    { direction: 'in', state: 'ok', created_at: { gte: from } },
    { orderBy: [['created_at', 'desc']], limit: CURRENT_KEYS_CHECK_ROWS },
  );
  for (const row of rows) {
    if (row.contact_id === null || row.envelope_json === null) continue;
    try {
      const parsed: unknown = JSON.parse(row.envelope_json);
      const recipients = (parsed as { recipients?: unknown }).recipients;
      if (!Array.isArray(recipients)) continue;
      if (recipients.some((r) => (r as { kid?: unknown } | null)?.kid === kid)) return true;
    } catch {
      // Not readable: no evidence.
    }
  }
  return false;
}

/**
 * The devices view over the context.
 *
 * DEVICES-INTERIM-2 (fail closed). Within OTHER_INSTALL_NOTICE_SECONDS of the newest sighting the
 * notice holds. After that it ends only when there is evidence that the other computer stopped rather
 * than moved out of sight: a contact's verified envelope, signed at or after the end of the week, that
 * is addressed to this computer's current agent key. Why: when the other computer moves this ID to a
 * newer key epoch (a rotation, such as the owner's contact-details update), its sent copies are wrapped
 * to the newer epoch's keys, which this computer neither subscribes to nor can derive (the KeyStore
 * refuses an epoch above its own; only an owner flow previews the next one), so it would see nothing
 * more and the notice would lapse while both computers can still spend. Contacts that applied the
 * newer card write to the newer keys only, so a contact still writing to this computer's keys after the
 * week shows the card did not move on. Nothing here widens what is accepted as a message: the check
 * reads only envelopes already stored as verified contact messages. A store or KeyStore read that fails
 * keeps the notice on. Residual: a contact that has not yet received the newer card can end it.
 */
export function devicesView(ctx: CoreContext): DevicesView {
  return Object.freeze({
    state: async (): Promise<DevicesState> => {
      await ensureInstall(ctx);
      const now = nowOf(ctx);
      const row = await ctx.store.transaction((tx) =>
        tx.get('install_state', { slot: SINGLETON_SLOT }),
      );
      if (row === undefined) return { otherInUse: false, otherSeenAt: null };
      const seen = row.other_seen_at;
      if (seen === null) return { otherInUse: false, otherSeenAt: null };
      const lapse = seen + OTHER_INSTALL_NOTICE_SECONDS;
      if (now < lapse) return { otherInUse: true, otherSeenAt: seen };
      let confirmed: boolean;
      try {
        const kid = encodeBase64url((await ctx.keyStore.getPublicBundle()).kid);
        confirmed = await ctx.store.transaction((tx) => currentKeysConfirmedTx(tx, kid, lapse));
      } catch {
        confirmed = false;
      }
      return { otherInUse: !confirmed, otherSeenAt: seen };
    },
  });
}
