// Identity (04 §2.4, §2.6, §2.9; 07 §3 `identity`).
//
// - agentId is the agent's EVM address, always derived from the seed through the KeyStore, never
//   chosen (04 §2.9). It is recorded with a random 16-byte storagePrefix that no key derives.
// - The agent card is signed by the owner (cardSig, EIP-712 by ownerEvm) through an OwnerSession, and
//   endorsed by the agent (cardAgentSig, EIP-712 by agentEvm) through the KeyStore. Both signatures
//   are checked before anything is stored, so a session of another owner is refused.
// - Rotation issues the card for keyEpoch + 1 once the KeyStore backend has advanced its epoch. Old
//   epoch keys stay derivable, so history stays readable (04 §2.6).
//
// I-4, D-54: the owner key unlocks only with presence collected by an owner surface (an interactive
// prompt, a passkey or a native window). The core never takes presence: owner flows (the CLI's own
// terminal, the local UI) hand it an OwnerSession that they unlocked, and no MCP tool reaches these
// methods. Everything signed is prepared before the store transaction, which is synchronous (07 §3.1).
import {
  encodeBase64url,
  encodeHex0x,
  agentCardNameHash,
  agentCardRelaysHash,
  canonicalize,
  parseAgentCardJson,
  randomBytes,
  verifyAgentCard,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type AgentCard,
  type OwnerPublicKeys,
  type OwnerSession,
  type PublicIdentity,
} from '@agentlink/crypto';
import {
  cardTypedData,
  checkName,
  checkRelays,
  ownerKeyFields,
  parseCard,
  sameOwnerKeys,
  type SignedCard,
} from './card.js';
import { STORAGE_PREFIX_BYTES } from './constants.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { SINGLETON_SLOT, type Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

export type { SignedCard } from './card.js';

/** The agent's own identity as stored. */
export interface IdentityView {
  readonly agentId: string;
  readonly keyEpoch: number;
  readonly storagePrefix: string;
  readonly card: AgentCard;
  readonly cardSig: string;
  readonly cardAgentSig: string;
  readonly revoked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** An owner flow's input to issue the first card. */
export interface InitIdentityInput {
  /** A session the owner surface unlocked with presence (04 §2.5). Never from an MCP tool. */
  readonly owner: OwnerSession;
  /** OwnerKeyStore.getPublicKeys(): the owner keys the card names. */
  readonly ownerKeys: OwnerPublicKeys;
  readonly name: string;
  readonly relays: readonly string[];
  /** Card expiry in unix seconds; 0 (default) means no expiry. */
  readonly expiresAt?: number;
}

export interface RotateIdentityInput {
  readonly owner: OwnerSession;
  readonly ownerKeys: OwnerPublicKeys;
  readonly expiresAt?: number;
}

function isRevoked(tx: StoreTx, row: Row<'identity'>): boolean {
  return (
    row.revoked_at !== null || tx.get('revoked_agents', { agent_evm: row.agent_id }) !== undefined
  );
}

function view(row: Row<'identity'>, revoked: boolean): IdentityView {
  let card: AgentCard;
  try {
    card = parseAgentCardJson(row.agent_card_json);
  } catch {
    throw new CoreError('store_unreadable', 'The stored identity could not be read.');
  }
  // The stored card is checked again on load; a card that no longer verifies is unreadable.
  if (
    card.agentEvm !== row.agent_id ||
    card.keyEpoch !== row.key_epoch ||
    !verifyAgentCard(card, row.card_sig, row.card_agent_sig)
  ) {
    throw new CoreError('store_unreadable', 'The stored identity could not be read.');
  }
  return {
    agentId: row.agent_id,
    keyEpoch: row.key_epoch,
    storagePrefix: row.storage_prefix,
    card,
    cardSig: row.card_sig,
    cardAgentSig: row.card_agent_sig,
    revoked,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class IdentityService {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** The stored identity, or undefined before init. */
  async get(): Promise<IdentityView | undefined> {
    const got = await this.#ctx.store.transaction((tx) => {
      const row = tx.select('identity')[0];
      return row === undefined ? undefined : { row, revoked: isRevoked(tx, row) };
    });
    return got === undefined ? undefined : view(got.row, got.revoked);
  }

  /** The current card with its signatures, name and relays (for invites and handshakes, M1-7c). */
  async signedCard(): Promise<SignedCard> {
    const row = await this.#ctx.store.transaction((tx) => tx.select('identity')[0]);
    if (row === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    const v = view(row, false);
    const key = [row.agent_id];
    const name = await open(this.#ctx, 'identity', 'name', key, row.name);
    const relays = checkStoredRelays(await open(this.#ctx, 'identity', 'relays', key, row.relays));
    return { card: v.card, cardSig: v.cardSig, cardAgentSig: v.cardAgentSig, name, relays };
  }

  /** Issues the first card and records the identity (04 §2.9: `init`). Never replaces one. */
  async init(input: InitIdentityInput): Promise<IdentityView> {
    const ctx = this.#ctx;
    const name = checkName(input.name);
    const relays = checkRelays(input.relays);
    const bundle = await ctx.keyStore.getPublicBundle();
    const existing = await ctx.store.transaction((tx) => tx.count('identity'));
    if (existing > 0) {
      throw new CoreError('identity_exists', 'This agent already has an identity.');
    }
    const now = nowOf(ctx);
    const signed = await this.#issue(bundle, input, name, relays, now);
    const key = [bundle.agentId];
    const row: Row<'identity'> = {
      agent_id: bundle.agentId,
      agent_card_json: canonicalize(signed.card),
      card_sig: signed.cardSig,
      card_agent_sig: signed.cardAgentSig,
      name: await seal(ctx, 'identity', 'name', key, name),
      relays: await seal(ctx, 'identity', 'relays', key, canonicalize(relays)),
      key_epoch: bundle.keyEpoch,
      storage_prefix: encodeBase64url(randomBytes(STORAGE_PREFIX_BYTES)),
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.transaction((tx) => {
      if (tx.count('identity') > 0) {
        throw new CoreError('identity_exists', 'This agent already has an identity.');
      }
      if (tx.get('revoked_agents', { agent_evm: bundle.agentId }) !== undefined) {
        throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
      }
      tx.insert('identity', row);
      // 07 §3.5: budget_state is created with identity.
      tx.insert('budget_state', {
        slot: SINGLETON_SLOT,
        ledger_epoch: 0,
        status: 'ok',
        newest_t: now,
        since: now,
        broken_at: null,
      });
    });
    ctx.log.info('identity created', { keyEpoch: bundle.keyEpoch });
    return view(row, false);
  }

  /**
   * Issues the card for keyEpoch + 1 (04 §2.6). The KeyStore must already be at that epoch (the
   * backend advances it, M1-8a); the EVM key, the name, the relays and the owner keys stay the same.
   */
  async rotate(input: RotateIdentityInput): Promise<IdentityView> {
    const ctx = this.#ctx;
    const current = await ctx.store.transaction((tx) => {
      const row = tx.select('identity')[0];
      return row === undefined ? undefined : { row, revoked: isRevoked(tx, row) };
    });
    if (current === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    if (current.revoked) {
      throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
    }
    const old = view(current.row, false);
    const bundle = await ctx.keyStore.getPublicBundle();
    if (bundle.agentId !== old.agentId) {
      throw new CoreError('identity_mismatch', 'The keys do not belong to this agent.');
    }
    if (bundle.keyEpoch !== old.keyEpoch + 1) {
      throw new CoreError(
        'key_epoch_mismatch',
        'The key store is not at the next key epoch for this agent.',
      );
    }
    // Owner-key rotation is P2 (04 §2.6): the new card names the same owner keys.
    if (!sameOwnerKeys(old.card, ownerKeyFields(input.ownerKeys))) {
      throw new CoreError('owner_keys_changed', 'The owner keys differ from the current card.');
    }
    const key = [old.agentId];
    const name = await open(ctx, 'identity', 'name', key, current.row.name);
    const relays = checkStoredRelays(
      await open(ctx, 'identity', 'relays', key, current.row.relays),
    );
    const now = nowOf(ctx);
    const signed = await this.#issue(bundle, input, name, relays, now);
    const patch = {
      agent_card_json: canonicalize(signed.card),
      card_sig: signed.cardSig,
      card_agent_sig: signed.cardAgentSig,
      key_epoch: bundle.keyEpoch,
      updated_at: now,
    };
    await ctx.store.transaction((tx) => {
      if (tx.get('revoked_agents', { agent_evm: old.agentId }) !== undefined) {
        throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
      }
      // Compare-and-set on the epoch it was issued from: a concurrent rotation changes nothing.
      const changed = tx.update(
        'identity',
        { agent_id: old.agentId, key_epoch: old.keyEpoch, revoked_at: null },
        patch,
      );
      if (changed !== 1) {
        throw new CoreError(
          'key_epoch_mismatch',
          'The identity changed while the new card was issued. Try again.',
        );
      }
    });
    ctx.log.info('identity rotated', { keyEpoch: bundle.keyEpoch });
    return view({ ...current.row, ...patch }, false);
  }

  /** Builds and signs a card: owner first, then agent; both verified before anything is stored. */
  async #issue(
    bundle: PublicIdentity,
    input: {
      readonly owner: OwnerSession;
      readonly ownerKeys: OwnerPublicKeys;
      readonly expiresAt?: number;
    },
    name: string,
    relays: readonly string[],
    now: number,
  ): Promise<{ card: AgentCard; cardSig: string; cardAgentSig: string }> {
    const owner = ownerKeyFields(input.ownerKeys);
    const card = parseCard({
      version: 1,
      agentEvm: bundle.agentId,
      agentNostr: encodeHex0x(bundle.agentNostr),
      agentEnc: encodeHex0x(bundle.agentEnc),
      ownerEvm: owner.ownerEvm,
      ownerNostr: owner.ownerNostr,
      ownerEnc: owner.ownerEnc,
      nameHash: encodeHex0x(agentCardNameHash(name)),
      relaysHash: encodeHex0x(agentCardRelaysHash(relays)),
      issuedAt: now,
      expiresAt: input.expiresAt ?? 0,
      keyEpoch: bundle.keyEpoch,
    });
    if (card.expiresAt !== 0 && card.expiresAt <= card.issuedAt) {
      throw new CoreError('card_invalid', 'The card expiry must be after its issue time.');
    }
    const typed = cardTypedData(card);
    const cardSig = await input.owner.sign712(typed);
    if (!verifyCardOwnerSig(card, cardSig)) {
      throw new CoreError(
        'card_owner_signature_invalid',
        'The owner session does not belong to the owner keys of the card.',
      );
    }
    const cardAgentSig = await this.#ctx.keyStore.sign712(typed);
    if (!verifyCardAgentSig(card, cardAgentSig)) {
      throw new CoreError(
        'card_agent_signature_invalid',
        'The agent key did not endorse the card.',
      );
    }
    return { card, cardSig, cardAgentSig };
  }
}

function checkStoredRelays(text: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CoreError('store_unreadable', 'A stored value could not be read.');
  }
  return checkRelays(parsed);
}
