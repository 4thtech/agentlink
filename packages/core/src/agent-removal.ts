// U3-e: the core side of removing an agent (04 §2.5 "Removing an agent", §2.5.1 `agent.revoke` and
// "The owner's revoked list", §3.4.1 `revoke`; 08 §1; D-58, D-138; I-1, I-2, I-4, I-7, I-10).
//
// - buildAgentRevokeBody: the unsigned `agent.revoke {reason: "retired"}` of the own agent, in its
//   one encoding (`expiresAt` = 0, permanent). The local app signs it with the owner's presence; the
//   browser never builds a body.
// - verifyRevokedEntry: re-verifies a revoked-list entry, which is the exact text of a signed
//   `agent.revoke` (never a plain record): strict text, schema, `agent` equal to the expected agent,
//   `expiresAt` = 0, and `sig` by its `owner` (or by the given owner key). Anything else is damaged
//   and the caller fails closed for that agent.
// - AgentRemovalService: what removal reads before anything is deleted (the contacts that are told,
//   the `storage.set` ids whose items go), and the `revoke` carriers to each active contact, sealed
//   with the owner as sender by the owner session of the removal gesture (04 §3.4.1, key table: the
//   agent key never signs an owner-authored type), stored with their outbox rows and published with a
//   bounded wait. The agent's own store never applies its revoke here: it is deleted right after.
//
// I-4: nothing here holds or asks for owner presence; the owner session is the caller's, and the
// `agent.revoke` signature is the authority. No MCP tool reaches this service. I-7: errors are fixed
// codes; nothing from a contact, a key or the signed object is logged.
import { canonicalize, type EnvelopeKeys, type JsonObject } from '@4thtech-io/crypto';
import {
  PROTOCOL_VERSION,
  agentRevokeActionSchema,
  signedAgentRevokeSchema,
  type AgentRevokeAction,
  type SignedAgentRevoke,
} from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { nowOf, open, type CoreContext } from './context.js';
import { outboundRow, sealRevokeCarrier } from './envelopes.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
import { parseOwnerActionText, verifyStoredOwnerAction } from './owner-action.js';
import { newOwnerActionNonce } from './owner-prepare.js';
import type { Row } from './store/schema.js';

/** The bounded wait for the `revoke` carriers to reach the relays (04 §2.5 step 4). */
export const REVOKE_DELIVERY_TIMEOUT_MS = 15_000;
/** How often the bounded wait publishes again while a carrier is still pending. */
const DELIVERY_POLL_MS = 1_000;
/** At most this many contacts are told in one removal (the store's contact cap is far below). */
const MAX_CARRIERS = 1_000;

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const STORAGE_ID = /^[0-9a-f]{16}$/;
const OWNER_KEY = /^[0-9a-f]{64}$/;

/** The unsigned `agent.revoke` and its JCS text: the exact bytes the owner signature covers. */
export interface BuiltAgentRevoke {
  readonly body: AgentRevokeAction;
  readonly jcs: string;
}

/**
 * Builds `agent.revoke {reason: "retired"}` for `agent` (04 §2.5.1): `expiresAt` = 0, a fresh nonce
 * unless one is given. Throws a TypeError (fixed text) when the input is not already canonical.
 */
export function buildAgentRevokeBody(input: {
  readonly agent: string;
  /** The owner Nostr x-only key, 64 lowercase hex without a prefix. */
  readonly owner: string;
  readonly issuedAt: number;
  readonly nonce?: string;
}): BuiltAgentRevoke {
  const candidate = {
    v: PROTOCOL_VERSION,
    agent: input.agent,
    owner: input.owner,
    op: 'agent.revoke',
    params: { reason: 'retired' },
    nonce: input.nonce ?? newOwnerActionNonce(),
    issuedAt: input.issuedAt,
    expiresAt: 0,
  };
  const parsed = agentRevokeActionSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError('agent.revoke: body not canonical');
  const jcs = canonicalize(parsed.data as never);
  if (jcs !== canonicalize(candidate as never)) {
    throw new TypeError('agent.revoke: body not canonical');
  }
  return { body: parsed.data, jcs };
}

/** A revoked-list entry, re-verified (04 §2.5.1 "The owner's revoked list"). */
export type RevokedEntryCheck =
  | {
      readonly ok: true;
      readonly signed: SignedAgentRevoke;
      /** The signing owner key as the object spells it: 64 lowercase hex. */
      readonly owner: string;
    }
  | { readonly ok: false };

/**
 * Re-verifies the exact text of a revoked-list entry as a signed `agent.revoke` for `agentId`: the
 * strict "Received text" parse, the strict schema (`op`, `params`, `expiresAt` = 0), `agent` equal to
 * `agentId`, and the BIP-340 `sig` by `ownerNostr` (`0x` + 64 hex) when given, else by the object's
 * own `owner` (restore refuses an entry under any owner, 04 §2.3.3). Pure; never throws.
 */
export function verifyRevokedEntry(
  text: unknown,
  agentId: string,
  ownerNostr?: string,
): RevokedEntryCheck {
  if (typeof text !== 'string' || !AGENT_ID.test(agentId)) return { ok: false };
  let input: unknown;
  try {
    input = parseOwnerActionText(text);
  } catch {
    return { ok: false };
  }
  const parsed = signedAgentRevokeSchema.safeParse(input);
  if (!parsed.success || parsed.data.body.agent !== agentId) return { ok: false };
  const owner = parsed.data.body.owner;
  if (!OWNER_KEY.test(owner)) return { ok: false };
  const checked = verifyStoredOwnerAction(text, {
    agent: agentId,
    ownerNostr: ownerNostr ?? `0x${owner}`,
  });
  if (!checked.ok || checked.signed.body.op !== 'agent.revoke') return { ok: false };
  return { ok: true, signed: parsed.data, owner };
}

/** What removal reads from the agent's store and identity before anything is deleted. */
export interface RemovalFacts {
  /** The agent's EVM address. */
  readonly agentId: string;
  /** `ownerNostr` of the agent's own card: `0x` + 64 hex. */
  readonly ownerNostr: string;
  /** Active, paired contacts: the ones its `revoke` goes to (04 §2.5 step 4). */
  readonly contacts: number;
  /** The `storage.set` ids recorded in `own_storage` (16 lowercase hex each). */
  readonly storageIds: readonly string[];
}

/** The outcome of the bounded wait (04 §2.5 step 4). */
export type RevokeDelivery = 'delivered' | 'undeliverable';

export interface RevokeDeliveryOptions {
  /** Default REVOKE_DELIVERY_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Test seams: a millisecond clock and a sleep. */
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AgentRemovalDeps {
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  readonly outbox: OutboxService;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The core side of removing this agent (U3-e). Construct through AgentLinkClient only. */
export class AgentRemovalService {
  readonly #ctx: CoreContext;
  readonly #deps: AgentRemovalDeps;

  constructor(ctx: CoreContext, deps: AgentRemovalDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /** The active, paired contacts, by id. */
  async #contactIds(): Promise<string[]> {
    return this.#ctx.store.transaction((tx) =>
      tx
        .select(
          'contacts',
          { status: 'active', pairing: 'complete' },
          { orderBy: [['contact_id', 'asc']] },
        )
        .map((row) => row.contact_id),
    );
  }

  /** The own identity, or `identity_missing`. */
  async #self() {
    const self = await this.#deps.identity.get();
    if (self === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    return self;
  }

  /**
   * The facts removal needs (04 §2.5 steps 4 and 6). A `storage.set` row that cannot be opened is
   * skipped: the backend still erases the id its `storage-mark` names.
   */
  async facts(): Promise<RemovalFacts> {
    const self = await this.#self();
    const contacts = (await this.#contactIds()).length;
    const rows: Row<'own_storage'>[] = await this.#ctx.store.transaction((tx) =>
      tx.select('own_storage'),
    );
    const storageIds: string[] = [];
    for (const row of rows) {
      try {
        const text = await open(this.#ctx, 'own_storage', 'signed_json', [row.id], row.signed_json);
        const parsed = JSON.parse(text) as { body?: { op?: unknown; params?: { id?: unknown } } };
        const id = parsed.body?.params?.id;
        if (parsed.body?.op === 'storage.set' && typeof id === 'string' && STORAGE_ID.test(id)) {
          if (!storageIds.includes(id)) storageIds.push(id);
        }
      } catch {
        // Unreadable: skipped (above).
      }
    }
    return Object.freeze({
      agentId: self.agentId,
      ownerNostr: self.card.ownerNostr,
      contacts,
      storageIds: Object.freeze(storageIds),
    });
  }

  /** The unsigned `agent.revoke {reason: "retired"}` of this agent, issued now. */
  async prepareRevoke(): Promise<JsonObject> {
    const self = await this.#self();
    const built = buildAgentRevokeBody({
      agent: self.agentId,
      owner: self.card.ownerNostr.slice(2),
      issuedAt: nowOf(this.#ctx),
    });
    return built.body as unknown as JsonObject;
  }

  /**
   * Seals one `revoke` carrier of `signedText` (this agent's verifying `agent.revoke`, signed by the
   * owner of its own card) to each active, paired contact with `ownerKeys` (the owner session), and
   * stores each envelope with its outbox rows. Returns the envelope ids, none with no contacts.
   * Throws (fixed codes) before anything is stored when the object does not verify.
   */
  async queueCarriers(signedText: string, ownerKeys: EnvelopeKeys): Promise<readonly string[]> {
    const { identity, outbox } = this.#deps;
    const self = await this.#self();
    const checked = verifyRevokedEntry(signedText, self.agentId, self.card.ownerNostr);
    if (!checked.ok) {
      throw new CoreError('payload_invalid', 'The message content is not valid.');
    }
    const ids = await this.#contactIds();
    if (ids.length === 0) return Object.freeze([]);
    outbox.requireTransport();
    const signed = parseOwnerActionText(signedText);
    const queued: string[] = [];
    for (const contactId of ids.slice(0, MAX_CARRIERS)) {
      const peer = await outbox.contactPeer(contactId);
      const routes = await outbox.routes(peer);
      const sealed = await sealRevokeCarrier(this.#ctx, identity, {
        signed,
        peer: peer.card,
        ownerKeys,
      });
      const keys = routes.map((r) => r.recipient);
      if (
        keys.length !== sealed.recipientNostrKeys.length ||
        !sealed.recipientNostrKeys.every((k) => keys.includes(k))
      ) {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      const rows = await outbox.prepareRows(sealed.envelope, routes, ownerKeys);
      const row = await outboundRow(this.#ctx, sealed, contactId);
      await this.#ctx.store.transaction((tx) => {
        tx.insert('envelopes', row);
        for (const r of rows) tx.insert('outbox', r);
      });
      queued.push(sealed.envelope.id);
    }
    this.#ctx.log.info('revoke queued for contacts', { envelopes: queued.length });
    return Object.freeze(queued);
  }

  /** True when every contact-role row of each envelope is `sent`; undefined while one is pending. */
  async #delivered(envelopeIds: readonly string[]): Promise<boolean | undefined> {
    return this.#ctx.store.transaction((tx) => {
      let pending = false;
      for (const envelopeId of envelopeIds) {
        const latest = new Map<string, Row<'outbox'>>();
        for (const row of tx.select('outbox', { envelope_id: envelopeId })) {
          const seen = latest.get(row.recipient_key);
          if (seen === undefined || row.attempt > seen.attempt) latest.set(row.recipient_key, row);
        }
        const contact = [...latest.values()].filter((r) => r.role === 'contact');
        if (contact.length === 0) return false;
        for (const row of contact) {
          if (row.state === 'not_delivered') return false;
          if (row.state !== 'sent') pending = true;
        }
      }
      return pending ? undefined : true;
    });
  }

  /**
   * Publishes the carriers and waits, at most `timeoutMs`, until each reached its contact's relays.
   * `undeliverable` when the wait ends first or a row cannot be delivered (offline, timeout); the
   * caller then asks the owner and never proceeds silently (04 §2.5 step 4).
   */
  async deliver(
    envelopeIds: readonly string[],
    options: RevokeDeliveryOptions = {},
  ): Promise<RevokeDelivery> {
    if (envelopeIds.length === 0) return 'delivered';
    const nowMs = options.nowMs ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const deadline = nowMs() + (options.timeoutMs ?? REVOKE_DELIVERY_TIMEOUT_MS);
    for (;;) {
      for (const id of envelopeIds) {
        try {
          await this.#deps.outbox.publishEnvelope(id);
        } catch {
          // A failed pass leaves the rows pending; the wait decides.
        }
      }
      let state: boolean | undefined;
      try {
        state = await this.#delivered(envelopeIds);
      } catch {
        state = false;
      }
      if (state === true) return 'delivered';
      if (state === false) return 'undeliverable';
      const left = deadline - nowMs();
      if (left <= 0) return 'undeliverable';
      await sleep(Math.min(DELIVERY_POLL_MS, left));
    }
  }
}
