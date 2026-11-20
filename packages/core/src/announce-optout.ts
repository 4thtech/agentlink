// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 07 §4.3 "Privacy" and "Card-update fan-out"; 04 §2.5.1
// `network.announce`, §7): "Don't also announce on the default servers".
//
// - Which servers. The release's default set (DEFAULT_RELAYS) and the old default set the release
//   dropped (LEGACY_READ_RELAYS): both are "the default servers" to the owner. The opt-out is allowed
//   only while the agent's own list holds none of them (the mix-in is off); otherwise `mix_in_on`.
// - What it stops (07 §4.3). With `identity.announce_default` false, the owner card-update goes to
//   the own and leaving servers only (card-update.ts announceToOwner), and the legacy card-update
//   fan-out to contacts stops (card-update.ts #send). Every route to a contact keeps that contact's
//   own list, which may well be the default set: that is the contact's choice, not this ID's.
// - Ending the retries (`withdrawFromDefaultServers`). Rows stored before the opt-out still name the
//   default or legacy servers and would retry there until their 24 h bound. Each pending card-update
//   row loses every default or legacy server that is on no own route now: the own list and the
//   leaving servers, and for an envelope to a contact also that contact's own list. The
//   relays are re-sealed with a compare-and-set on the row (state pending, the same sealed relays), so
//   a concurrent attempt or another process is never overwritten. It runs right after the owner's
//   `network.announce` and at the start of every owner announce pass (each sync), so a crash in
//   between leaves nothing behind. A row whose relays do not open is left to the outbox (it ends it
//   as unreadable). A row that would keep no server keeps none, and the outbox ends it (IR F2).
//
// I-7: counts only; never a list, a host or a key in a log.
import { canonicalize, parseJson } from '@4thtech-io/crypto';
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { agentNostrKey } from './card.js';
import { open, seal, type CoreContext } from './context.js';
import type { AgentCard } from '@4thtech-io/crypto';
import type { IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
import type { Row } from './store/schema.js';

/** The servers the opt-out keeps this ID off: the default set and the old default set. */
export const DEFAULT_AND_LEGACY_SERVERS: ReadonlySet<string> = new Set([
  ...DEFAULT_RELAYS,
  ...LEGACY_READ_RELAYS,
]);

/**
 * IR NET-ANNOUNCE-OPTOUT F2: a contact (or a staged inviter) as the exception sees it: its servers,
 * and the only recipients they are allowed for, its agent key and its owner key (Nostr, x-only hex).
 */
export interface PeerServers {
  readonly keys: ReadonlySet<string>;
  readonly relays: ReadonlySet<string>;
}

export const NO_PEER: PeerServers = Object.freeze({
  keys: new Set<string>(),
  relays: new Set<string>(),
});

export function peerServersOf(peer: {
  readonly card: AgentCard;
  readonly relays: readonly string[];
}): PeerServers {
  return {
    keys: new Set([agentNostrKey(peer.card), peer.card.ownerNostr.slice(2)]),
    relays: new Set(peer.relays),
  };
}

/** Whether a list holds a default or an old default server (the opt-out is then refused). */
export function holdsDefaultServer(relays: readonly string[]): boolean {
  return relays.some((r) => DEFAULT_AND_LEGACY_SERVERS.has(r));
}

export interface WithdrawDeps {
  readonly identity: Pick<IdentityService, 'announceDefault' | 'relays'>;
  readonly outbox: Pick<OutboxService, 'leavingRelays' | 'contactPeer'>;
}

/** The relays one pending row keeps: `relays` without the off-limits ones outside `allowed`. */
function kept(relays: readonly string[], allowed: ReadonlySet<string>): readonly string[] {
  return relays.filter((r) => !DEFAULT_AND_LEGACY_SERVERS.has(r) || allowed.has(r));
}

/**
 * With the opt-out on, removes the default and legacy servers from every pending card-update row
 * that names one outside its recipient's own route (see the header). Returns how many rows changed;
 * 0 with the opt-out off. Writes nothing else; never throws for one row.
 */
export async function withdrawFromDefaultServers(
  ctx: CoreContext,
  deps: WithdrawDeps,
): Promise<number> {
  if (await deps.identity.announceDefault()) return 0;
  const rows = await ctx.store.transaction((tx) =>
    tx
      .select('outbox', { state: 'pending' })
      .map((row) => ({ row, env: tx.get('envelopes', { envelope_id: row.envelope_id }) }))
      .filter(({ env }) => env?.direction === 'out' && env.type === 'card-update'),
  );
  if (rows.length === 0) return 0;
  const own = new Set([...(await deps.identity.relays()), ...(await deps.outbox.leavingRelays())]);
  const contactLists = new Map<string, PeerServers>();
  const contactList = async (contactId: string): Promise<PeerServers> => {
    let got = contactLists.get(contactId);
    if (got === undefined) {
      try {
        got = peerServersOf(await deps.outbox.contactPeer(contactId));
      } catch {
        // IR L3, fail closed: an unreadable contact list allows none of the default servers.
        got = NO_PEER;
      }
      contactLists.set(contactId, got);
    }
    return got;
  };
  let changed = 0;
  for (const { row, env } of rows) {
    // The owner channel: the own list and the leaving servers. A contact's envelope: those and the
    // contact's own list (its agent and its owner are reached there, whatever servers they are).
    const contactId = env?.contact_id ?? null;
    const peer = contactId === null ? NO_PEER : await contactList(contactId);
    // IR F2: the contact's servers only on the rows to its agent or owner key, never the own copies.
    const theirs = peer.keys.has(row.recipient_key) ? peer.relays : NO_PEER.relays;
    if (await rewrite(ctx, row, new Set([...own, ...theirs]))) changed += 1;
  }
  if (changed > 0) ctx.log.info('card updates kept off the default servers', { rows: changed });
  return changed;
}

/** One row's compare-and-set (see the header). True when it changed. */
async function rewrite(
  ctx: CoreContext,
  row: Row<'outbox'>,
  allowed: ReadonlySet<string>,
): Promise<boolean> {
  let relays: readonly string[];
  try {
    const listed = parseJson(await open(ctx, 'outbox', 'relays', [row.wrap_id], row.relays));
    if (!Array.isArray(listed) || !listed.every((r) => typeof r === 'string')) return false;
    relays = listed as string[];
  } catch {
    return false;
  }
  const next = kept(relays, allowed);
  // A row left with no server (own copies built for a list of default servers only) keeps none:
  // the outbox then ends it by its usual rules (no relays: not delivered), never publishing there.
  if (next.length === relays.length) return false;
  const sealed = await seal(ctx, 'outbox', 'relays', [row.wrap_id], canonicalize([...next]));
  return ctx.store.transaction(
    (tx) =>
      tx.update(
        'outbox',
        { wrap_id: row.wrap_id, state: 'pending', relays: row.relays },
        { relays: sealed },
      ) === 1,
  );
}
