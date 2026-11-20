// NET-PROBE / NET-STATS / NET-ROUTE (07 §4.3; 08 §1 Message network; I-4, I-5, I-7): the core side
// of the app's Message network view (Advanced › Message network, Under the hood only).
//
// Read-only. It answers which servers the agent uses and in which role (own: sends and reads; legacy:
// read only for the transition), whether the own list is the automatic set, the last per-server
// counters (relay-stats.ts), a bounded probe of exactly those servers (outbox relayProbe), and how
// many contacts share at least one server with us. A contact's list is read only when the caller
// asks for it (the expanded view); it is inbound content (I-5) and the local app shows host text only.
// Nothing here signs, changes a list or opens a URL a caller gives: no MCP tool reaches it (I-4).
import { holdsDefaultServer } from './announce-optout.js';
import {
  DEFAULT_RELAYS,
  LEGACY_CARD_UPDATE_UNTIL,
  LEGACY_READ_RELAYS,
  relayOrigin,
  type RelayProbeResult,
} from '@4thtech-io/transport-nostr';
import type { ContactBook } from './contacts.js';
import type { CoreContext } from './context.js';
import { readIdentity, type IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
import { migrationDroppedRelays } from './relay-migration.js';
import { readRelayStats, relayStatsMark, type RelayStatsView } from './relay-stats.js';

/** The legacy servers are read for at least 30 days after the card-update fan-out ends (07 §4.3). */
export const LEGACY_READ_UNTIL = LEGACY_CARD_UPDATE_UNTIL + 30 * 86_400;
/** The expanded view reads at most this many contacts' lists. */
export const MAX_NETWORK_CONTACT_LISTS = 64;

export type NetworkServerKind = 'own' | 'legacy';

export interface NetworkServerEntry {
  readonly relay: string;
  readonly kind: NetworkServerKind;
}

/** The servers the view lists: the own list, then each legacy server not already own. */
export function networkServerList(
  own: readonly string[],
  legacy: readonly string[] = LEGACY_READ_RELAYS,
): readonly NetworkServerEntry[] {
  const out: NetworkServerEntry[] = [];
  const seen = new Set<string>();
  for (const relay of own) {
    if (seen.has(relay)) continue;
    seen.add(relay);
    out.push({ relay, kind: 'own' });
  }
  for (const relay of legacy) {
    if (seen.has(relay)) continue;
    seen.add(relay);
    out.push({ relay, kind: 'legacy' });
  }
  return out;
}

/** `automatic` while every own server is one of the default set; else `custom`. */
export function networkMode(own: readonly string[]): 'automatic' | 'custom' {
  return own.every((r) => DEFAULT_RELAYS.includes(r)) ? 'automatic' : 'custom';
}

/** How many distinct server origins of `theirs` are also in `own`. */
export function sharedServerCount(own: readonly string[], theirs: readonly string[]): number {
  const mine = new Set(own.map(relayOrigin));
  mine.delete('wss://invalid');
  const shared = new Set<string>();
  for (const r of theirs) {
    const o = relayOrigin(r);
    if (mine.has(o)) shared.add(o);
  }
  return shared.size;
}

export interface NetworkServers {
  readonly paused: boolean;
  readonly mode: 'automatic' | 'custom';
  readonly own: readonly string[];
  readonly legacy: readonly string[];
  /** Unix seconds: the legacy servers are read at least until then. */
  readonly legacyReadUntil: number;
  /** D-157 (2): own entries the pending contact-details update would leave out (0: none, or none pending). */
  readonly updateDrops: number;
  /**
   * 0.5.15 (08 §1 `GET /api/ui/network` additions; D-158): true when the own list holds a default
   * (or old default) server, the mix-in; the announce choice; the latest end of the leaving servers
   * (unix seconds, null when none runs); and why changing servers is off now.
   */
  readonly mixIn: boolean;
  readonly announceDefault: boolean;
  readonly previousUntil: number | null;
  readonly change: null | 'paused' | 'rotation_pending';
}

export interface NetworkContactList {
  /** The contact's ID (its agent's address), as the Contacts page already uses it. */
  readonly contactId: string;
  /** The contact's current list (inbound content, I-5). */
  readonly relays: readonly string[];
  readonly shared: number;
}

export interface NetworkContactReach {
  /** Active contacts. */
  readonly total: number;
  /** Active contacts sharing at least one server with our own list. */
  readonly sharing: number;
  /**
   * Per origin (`wss://host[:port]`) of our own and legacy servers only: how many active contacts
   * list it in their card. Counts only; a contact's other servers are never named here.
   */
  readonly perServer: Readonly<Record<string, number>>;
  readonly lists?: readonly NetworkContactList[];
}

/** The Message network view's reads (client.network). */
export class NetworkService {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;
  readonly #outbox: OutboxService;
  readonly #pause: { paused(): Promise<boolean> } | undefined;

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    contacts: ContactBook,
    outbox: OutboxService,
    pause?: { paused(): Promise<boolean> },
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
    this.#outbox = outbox;
    this.#pause = pause;
  }

  /**
   * The own and legacy lists, whether the agent is paused, and how many own entries a pending
   * contact-details update would leave out (D-157 (2)). Throws (a CoreError, fixed text) when the
   * own list cannot be read: the local app answers that as unavailable, never as an empty network.
   */
  async servers(): Promise<NetworkServers> {
    const own = await this.#identity.relays();
    let paused: boolean;
    try {
      paused = this.#pause !== undefined && (await this.#pause.paused());
    } catch {
      paused = true; // fail closed, like the outbox: an unreadable pause row reads as paused
    }
    let announceDefault: boolean;
    try {
      announceDefault = await this.#identity.announceDefault();
    } catch {
      announceDefault = true;
    }
    let previousUntil: number | null = null;
    try {
      for (const e of await this.#identity.leavingServers()) {
        if (previousUntil === null || e.until > previousUntil) previousUntil = e.until;
      }
    } catch {
      previousUntil = null;
    }
    // A change still finishing: the pending card is stored (a store read only, no KeyStore call, so
    // the view's polling adds no keychain read).
    let rotating: boolean;
    try {
      rotating = (await readIdentity(this.#ctx))?.row.pending_card_json != null;
    } catch {
      rotating = false;
    }
    return Object.freeze({
      mixIn: holdsDefaultServer(own),
      announceDefault,
      previousUntil,
      change: paused ? ('paused' as const) : rotating ? ('rotation_pending' as const) : null,
      paused,
      mode: networkMode(own),
      own: Object.freeze([...own]),
      // NET-ANNOUNCE-OPTOUT (fully quiet): none while the opt-out is on.
      legacy: await this.#outbox.legacyReadRelays(),
      legacyReadUntil: LEGACY_READ_UNTIL,
      updateDrops: migrationDroppedRelays(own),
    });
  }

  /** One bounded probe of the own and legacy servers (outbox relayProbe). Never throws. */
  probe(): Promise<
    readonly { readonly relay: string; readonly result: RelayProbeResult }[] | undefined
  > {
    return this.#outbox.relayProbe();
  }

  /** The per-server counters (relay-stats.ts). Never throws. */
  stats(): Promise<readonly RelayStatsView[]> {
    return readRelayStats(this.#ctx);
  }

  /** An opaque mark of the counters (numbers only), for the app's live event. Never throws. */
  async statsMark(): Promise<string> {
    return relayStatsMark(await readRelayStats(this.#ctx));
  }

  /**
   * How many active contacts share at least one server with our own list; with `lists`, also each
   * contact's list (at most MAX_NETWORK_CONTACT_LISTS). A contact whose list cannot be read counts
   * as not sharing and is left out of the lists.
   */
  async contactReach(options: { readonly lists: boolean }): Promise<NetworkContactReach> {
    const own = await this.#identity.relays();
    const active = (await this.#contacts.list()).filter((c) => c.status === 'active');
    let sharing = 0;
    const lists: NetworkContactList[] = [];
    // Counted in the same pass (one list read per contact), for our own and legacy servers only.
    const perServer = new Map<string, number>();
    for (const r of [...own, ...(await this.#outbox.legacyReadRelays())]) {
      const o = relayOrigin(r);
      if (o !== 'wss://invalid') perServer.set(o, 0);
    }
    for (const contact of active) {
      let relays: readonly string[];
      try {
        relays = (await this.#outbox.contactPeer(contact.id)).relays;
      } catch {
        continue;
      }
      const shared = sharedServerCount(own, relays);
      if (shared > 0) sharing += 1;
      for (const o of new Set(relays.map(relayOrigin))) {
        const n = perServer.get(o);
        if (n !== undefined) perServer.set(o, n + 1);
      }
      if (options.lists && lists.length < MAX_NETWORK_CONTACT_LISTS) {
        lists.push(Object.freeze({ contactId: contact.id, relays, shared }));
      }
    }
    return Object.freeze({
      total: active.length,
      sharing,
      perServer: Object.freeze(Object.fromEntries(perServer)),
      ...(options.lists ? { lists: Object.freeze(lists) } : {}),
    });
  }
}
