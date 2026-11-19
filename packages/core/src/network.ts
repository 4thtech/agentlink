// NET-PROBE / NET-STATS / NET-ROUTE (07 §4.3; 08 §1 Message network; I-4, I-5, I-7): the core side
// of the app's Message network view (Advanced › Message network, Under the hood only).
//
// Read-only. It answers which servers the agent uses and in which role (own: sends and reads; legacy:
// read only for the transition), whether the own list is the automatic set, the last per-server
// counters (relay-stats.ts), a bounded probe of exactly those servers (outbox relayProbe), and how
// many contacts share at least one server with us. A contact's list is read only when the caller
// asks for it (the expanded view); it is inbound content (I-5) and the local app shows host text only.
// Nothing here signs, changes a list or opens a URL a caller gives: no MCP tool reaches it (I-4).
import {
  DEFAULT_RELAYS,
  LEGACY_CARD_UPDATE_UNTIL,
  LEGACY_READ_RELAYS,
  relayOrigin,
  type RelayProbeResult,
} from '@4thtech-io/transport-nostr';
import type { ContactBook } from './contacts.js';
import type { CoreContext } from './context.js';
import type { IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
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

  /** The own and legacy lists and whether the agent is paused. Undefined without an own list. */
  async servers(): Promise<NetworkServers | undefined> {
    try {
      const own = await this.#identity.relays();
      let paused = false;
      try {
        paused = this.#pause !== undefined && (await this.#pause.paused());
      } catch {
        paused = true; // fail closed, like the outbox: an unreadable pause row reads as paused
      }
      return Object.freeze({
        paused,
        mode: networkMode(own),
        own: Object.freeze([...own]),
        legacy: LEGACY_READ_RELAYS,
        legacyReadUntil: LEGACY_READ_UNTIL,
      });
    } catch {
      return undefined;
    }
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
    for (const contact of active) {
      let relays: readonly string[];
      try {
        relays = (await this.#outbox.contactPeer(contact.id)).relays;
      } catch {
        continue;
      }
      const shared = sharedServerCount(own, relays);
      if (shared > 0) sharing += 1;
      if (options.lists && lists.length < MAX_NETWORK_CONTACT_LISTS) {
        lists.push(Object.freeze({ contactId: contact.id, relays, shared }));
      }
    }
    return Object.freeze({
      total: active.length,
      sharing,
      ...(options.lists ? { lists: Object.freeze(lists) } : {}),
    });
  }
}
