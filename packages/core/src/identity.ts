// Identity (04 §2.4, §2.6, §2.9; 07 §3 `identity`).
//
// - agentId is the agent's EVM address, always derived from the seed through the KeyStore, never
//   chosen (04 §2.9). It is recorded with a random 16-byte storagePrefix that no key derives.
// - The agent card is signed by the owner (cardSig, EIP-712 by ownerEvm) through an OwnerSession, and
//   endorsed by the agent (cardAgentSig, EIP-712 by agentEvm) through the KeyStore. Both signatures
//   are checked before anything is stored, so a session of another owner is refused. The signed card
//   is sealed at rest (`enc`), like the name and relays (IR-M1-7a-1 M-3).
// - Each own card also gets its proof of possession (M1-4d-d; 04 §2.9, D-102): `cardPop`, BIP-340 by
//   the card's agentNostr through KeyStore.signCardPop, which signs only at the KeyStore's current
//   epoch. So init signs it at once, and a rotation signs it once the KeyStore is at the new epoch
//   (after the advance, or when finishing a pending rotation). A card stored before M1-4d-d gets it
//   on first use while the KeyStore still holds that epoch's keys (signedCard), written with a
//   compare-and-set on the sealed card read: a lost race is read again, never ignored (M1-4d-f).
// - Card history (M1-4d-f; 07 §8): the sealed own card also keeps the agent's earlier cards, one per
//   key epoch with their signatures (ownCardText), so a proof pack for an envelope sent at an
//   earlier epoch carries that epoch's card. A rotation moves the current card into the history,
//   and signs its `cardPop` first when it still lacks one and the KeyStore is still at its epoch.
// - Rotation issues the card for keyEpoch + 1 (04 §2.6; M1-1g-d, IR-M1-7a-1 Q1). The owner flow passes
//   the backend's KeyEpochControl: preview the next epoch's public keys, sign the next card, store it
//   as pending, advance the KeyStore with a compare-and-set, then commit key_epoch. Old epoch keys
//   stay derivable, so history stays readable. While the KeyStore is one epoch ahead of the stored
//   card, the agent must not send (sendState `rotation_pending`, L-1); on open, a pending card the
//   owner signed for exactly the KeyStore's epoch finishes the rotation (finishPendingRotation).
//
// I-4, D-54: the owner key unlocks only with presence collected by an owner surface (an interactive
// prompt, a passkey or a native window). The core never takes presence: owner flows (the CLI's own
// terminal, the local UI) hand it an OwnerSession that they unlocked, and no MCP tool reaches these
// methods. Everything signed is prepared before the store transaction, which is synchronous (07 §3.1).
import {
  agentCardNameHash,
  agentCardRelaysHash,
  agentFingerprint,
  canonicalize,
  decodeHex,
  decodeHex0x,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  formatFingerprint,
  KeyStoreError,
  randomBytes,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  verifyCardPop,
  type AgentCard,
  type KeyEpochControl,
  type OwnerPublicKeys,
  type OwnerSession,
  type PublicIdentity,
} from '@4thtech-io/crypto';
import {
  cardPopInvalid,
  cardTypedData,
  checkName,
  checkRelays,
  ownCardText,
  ownerFingerprintHex,
  ownerKeyFields,
  parseCard,
  parseOwnCardText,
  parseStoredCard,
  sameOwnerKeys,
  storedCardText,
  type SignedCard,
  type StoredCard,
} from './card.js';
import { STORAGE_PREFIX_BYTES } from './constants.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { SINGLETON_SLOT, type Row, type Sealed } from './store/schema.js';
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
  /**
   * The card's `cardPop` (04 §2.9, D-102). Null only for a card stored before M1-4d-d that has not
   * been used since; signedCard() adds it.
   */
  readonly cardPop: string | null;
  readonly revoked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A fingerprint in its display forms (04 §2.9): `short` (default views) and `long` (64 hex). */
export interface FingerprintForms {
  readonly short: string;
  readonly long: string;
}

/**
 * The agent's own fingerprints for the local UI (M1-11r-a): hashes of public keys only. They tell
 * agents and owners apart and authenticate nothing (04 §2.9).
 */
export interface OwnFingerprints {
  readonly agent: FingerprintForms;
  readonly owner: FingerprintForms;
}

/**
 * Whether the agent may send and sign (L-1). `rotation_pending`: the KeyStore is one epoch ahead of
 * the stored card, so contacts would not know its keys until the owner completes `rotate`.
 * `key_epoch_mismatch`: the KeyStore is behind the stored card (another process rotated).
 */
export type SendState =
  'ready' | 'no_identity' | 'revoked' | 'rotation_pending' | 'key_epoch_mismatch';

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
  /**
   * The agent KeyStore backend's epoch control (M1-1g-d), held by the owner flow, never by
   * MCP-reachable code (I-4). Needed when the KeyStore is still at the stored epoch; when it is
   * already one ahead (a rotation interrupted after the advance), the rotation finishes without it.
   */
  readonly epochControl?: KeyEpochControl;
}

function isRevoked(tx: StoreTx, row: Row<'identity'>): boolean {
  return (
    row.revoked_at !== null || tx.get('revoked_agents', { agent_evm: row.agent_id }) !== undefined
  );
}

/**
 * Reads the own identity row and whether it is revoked, in one transaction. Undefined before init.
 * With openOwnCard, the one "read and re-verify the own stored card" path that IdentityService,
 * ContactBook and OwnerActions share (IR-M1-7c-b-1 F03).
 */
export function readIdentity(
  ctx: CoreContext,
): Promise<{ readonly row: Row<'identity'>; readonly revoked: boolean } | undefined> {
  return ctx.store.transaction((tx) => {
    const row = tx.select('identity')[0];
    return row === undefined ? undefined : { row, revoked: isRevoked(tx, row) };
  });
}

/**
 * Opens the own identity row's sealed card and re-verifies it: both card signatures
 * (parseStoredCard, which throws `store_unreadable` for anything that is not a validly signed card),
 * `cardAgentSig` present, and the card's agentEvm and keyEpoch equal to the row's. Undefined when the
 * card no longer matches its row; each caller decides what that means (IR-M1-7c-b-1 F03).
 */
export async function openOwnCard(
  ctx: CoreContext,
  row: Row<'identity'>,
): Promise<OwnStoredCard | undefined> {
  const text = await open(ctx, 'identity', 'agent_card_json', [row.agent_id], row.agent_card_json);
  const { current: stored, history } = parseOwnCardText(text);
  if (
    stored.cardAgentSig === null ||
    stored.card.agentEvm !== row.agent_id ||
    stored.card.keyEpoch !== row.key_epoch
  ) {
    return undefined;
  }
  return { ...stored, cardAgentSig: stored.cardAgentSig, history };
}

/** The own current card, re-verified, with its earlier cards (oldest first, M1-4d-f). */
export type OwnStoredCard = StoredCard & {
  readonly cardAgentSig: string;
  readonly history: readonly StoredCard[];
};

/** Only the stored-card fields of a card (a history entry). */
const storedOf = (h: StoredCard): StoredCard => ({
  card: h.card,
  cardSig: h.cardSig,
  cardAgentSig: h.cardAgentSig,
  cardPop: h.cardPop,
});

/** Attempts of signedCard() to add a late `cardPop` before a lost compare-and-set is reported. */
const CARD_POP_ATTEMPTS = 3;

export class IdentityService {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** Opens and re-verifies the sealed card; a card that no longer verifies is unreadable. */
  async #view(row: Row<'identity'>, revoked: boolean): Promise<IdentityView> {
    const stored = await openOwnCard(this.#ctx, row);
    if (stored === undefined) {
      throw new CoreError('store_unreadable', 'The stored identity could not be read.');
    }
    return {
      agentId: row.agent_id,
      keyEpoch: row.key_epoch,
      storagePrefix: row.storage_prefix,
      card: stored.card,
      cardSig: stored.cardSig,
      cardAgentSig: stored.cardAgentSig,
      cardPop: stored.cardPop,
      revoked,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** The stored identity, or undefined before init. */
  async get(): Promise<IdentityView | undefined> {
    const got = await readIdentity(this.#ctx);
    return got === undefined ? undefined : this.#view(got.row, got.revoked);
  }

  /**
   * The own agent and owner fingerprints (M1-11r-a, the local UI's Advanced page), from the stored
   * card, which is re-verified. Public values only. Undefined before init.
   */
  async fingerprints(): Promise<OwnFingerprints | undefined> {
    const view = await this.get();
    if (view === undefined) return undefined;
    const agent = agentFingerprint(decodeHex0x(view.agentId, { length: 20 }));
    const owner = ownerFingerprintHex(view.card);
    return Object.freeze({
      agent: Object.freeze({ short: formatFingerprint(agent, 'short'), long: encodeHex(agent) }),
      owner: Object.freeze({
        short: formatFingerprint(decodeHex(owner, { length: 32 }), 'short'),
        long: owner,
      }),
    });
  }

  /**
   * The agent ID (its public address): the account its credits are kept for, shown as a QR code to
   * add credits (M1-11r-a). Undefined before init.
   */
  async agentAddress(): Promise<string | undefined> {
    return (await readIdentity(this.#ctx))?.row.agent_id;
  }

  /**
   * The agent's own relays as stored with its card (07 §4.3; M1-11r-a, Advanced). Public: every
   * invite carries them. Empty before init.
   */
  async relays(): Promise<readonly string[]> {
    const got = await readIdentity(this.#ctx);
    if (got === undefined) return Object.freeze([]);
    const text = await open(this.#ctx, 'identity', 'relays', [got.row.agent_id], got.row.relays);
    return Object.freeze([...checkStoredRelays(text)]);
  }

  /** The current card with its signatures, name and relays (for invites and handshakes, M1-7c). */
  async signedCard(): Promise<SignedCard> {
    // A card without its `cardPop` gets one here; a lost compare-and-set reads the row again, so the
    // card returned is always the one stored (M1-4d-f). A race that keeps losing is reported.
    for (let attempt = 0; attempt < CARD_POP_ATTEMPTS; attempt += 1) {
      const got = await readIdentity(this.#ctx);
      if (got === undefined) {
        throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
      }
      // 07 §3.4: a revoked agent stops signing and sending, so it hands out no card (L-3).
      if (got.revoked) {
        throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
      }
      const stored = await openOwnCard(this.#ctx, got.row);
      if (stored === undefined) {
        throw new CoreError('store_unreadable', 'The stored identity could not be read.');
      }
      const cardPop = stored.cardPop ?? (await this.#addCardPop(got.row, stored));
      if (cardPop === undefined) continue;
      const key = [got.row.agent_id];
      const name = await open(this.#ctx, 'identity', 'name', key, got.row.name);
      const relays = checkStoredRelays(
        await open(this.#ctx, 'identity', 'relays', key, got.row.relays),
      );
      return {
        card: stored.card,
        cardSig: stored.cardSig,
        cardAgentSig: stored.cardAgentSig,
        cardPop,
        name,
        relays,
      };
    }
    this.#ctx.log.warn('card proof of possession not stored: the identity kept changing');
    throw concurrentRotation();
  }

  /**
   * A card stored before M1-4d-d (04 §2.9): signs its `cardPop` once, while the KeyStore is at the
   * card's epoch, and stores it with the card and its history, as a compare-and-set on the sealed
   * card read. Undefined when that write lost (another process changed the card meanwhile): the
   * caller reads again, so a value that was not stored is never handed out (M1-4d-f). With the
   * KeyStore at another epoch the card's Nostr key cannot sign: `key_epoch_mismatch` or
   * `rotation_pending`, the states in which the agent does not send anyway.
   */
  async #addCardPop(row: Row<'identity'>, stored: OwnStoredCard): Promise<string | undefined> {
    const ctx = this.#ctx;
    await this.assertCanSend();
    const cardPop = await this.#signCardPop(stored.card);
    const sealed = await seal(
      ctx,
      'identity',
      'agent_card_json',
      [row.agent_id],
      ownCardText({ ...stored, cardPop }, stored.history),
    );
    const written = await ctx.store.transaction((tx) =>
      tx.update(
        'identity',
        {
          agent_id: row.agent_id,
          key_epoch: row.key_epoch,
          revoked_at: null,
          agent_card_json: row.agent_card_json,
        },
        { agent_card_json: sealed },
      ),
    );
    if (written !== 1) {
      ctx.log.info('card proof of possession race lost', { keyEpoch: row.key_epoch });
      return undefined;
    }
    ctx.log.info('card proof of possession added', { keyEpoch: row.key_epoch });
    return cardPop;
  }

  /** `cardPop` through the KeyStore (current epoch only), verified before it is used or stored. */
  async #signCardPop(card: AgentCard): Promise<string> {
    const cardPop = await this.#ctx.keyStore.signCardPop(card);
    if (!verifyCardPop(card, cardPop)) throw cardPopInvalid();
    return cardPop;
  }

  /** Whether the agent may send and sign now (L-1). The send paths (M1-7b) call assertCanSend. */
  async sendState(): Promise<SendState> {
    const got = await readIdentity(this.#ctx);
    if (got === undefined) return 'no_identity';
    if (got.revoked) return 'revoked';
    const bundle = await this.#ctx.keyStore.getPublicBundle();
    if (bundle.agentId !== got.row.agent_id) return 'key_epoch_mismatch';
    if (bundle.keyEpoch === got.row.key_epoch + 1) return 'rotation_pending';
    if (bundle.keyEpoch !== got.row.key_epoch) return 'key_epoch_mismatch';
    return 'ready';
  }

  /** Throws unless sendState() is `ready`. */
  async assertCanSend(): Promise<void> {
    switch (await this.sendState()) {
      case 'ready':
        return;
      case 'no_identity':
        throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
      case 'revoked':
        throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
      case 'rotation_pending':
        throw new CoreError(
          'rotation_pending',
          'A key rotation is waiting for the owner. Ask the owner to finish it before sending.',
        );
      case 'key_epoch_mismatch':
        throw new CoreError(
          'key_epoch_mismatch',
          'The key store epoch does not match this agent. Restart AgentLink.',
        );
    }
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
      agent_card_json: await seal(ctx, 'identity', 'agent_card_json', key, storedCardText(signed)),
      name: await seal(ctx, 'identity', 'name', key, name),
      relays: await seal(ctx, 'identity', 'relays', key, canonicalize([...relays])),
      pending_card_json: null,
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
    return this.#view(row, false);
  }

  /**
   * Issues the card for keyEpoch + 1 (04 §2.6) and moves the KeyStore there (M1-1g-d). With the
   * KeyStore at the stored epoch n: previewEpoch(n + 1), sign the card (owner, then agent), store it
   * as pending, advanceEpoch(n, owner) (compare-and-set), commit key_epoch = n + 1. With the KeyStore
   * already at n + 1 (an interrupted rotation, or a backend advanced elsewhere), sign and commit. The
   * EVM key, the name, the relays and the owner keys stay the same. Of concurrent rotations, one
   * wins; the others fail a compare-and-set (`key_epoch_mismatch`).
   */
  async rotate(input: RotateIdentityInput): Promise<IdentityView> {
    const ctx = this.#ctx;
    const current = await readIdentity(ctx);
    if (current === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    if (current.revoked) {
      throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
    }
    const old = await this.#view(current.row, false);
    const oldStored = await openOwnCard(ctx, current.row);
    if (oldStored === undefined) {
      throw new CoreError('store_unreadable', 'The stored identity could not be read.');
    }
    const bundle = await ctx.keyStore.getPublicBundle();
    if (bundle.agentId !== old.agentId) {
      throw new CoreError('identity_mismatch', 'The keys do not belong to this agent.');
    }
    let next: PublicIdentity;
    let control: KeyEpochControl | undefined;
    if (bundle.keyEpoch === old.keyEpoch + 1) {
      next = bundle;
    } else if (bundle.keyEpoch === old.keyEpoch && input.epochControl !== undefined) {
      control = input.epochControl;
      try {
        next = await control.previewEpoch(old.keyEpoch + 1);
      } catch (error) {
        // The KeyStore moved since it was read: the same error as a lost compare-and-set (L-3).
        throw isEpochConflict(error) ? concurrentRotation() : error;
      }
      if (next.agentId !== old.agentId) {
        throw new CoreError('identity_mismatch', 'The keys do not belong to this agent.');
      }
      if (next.keyEpoch !== old.keyEpoch + 1) throw nextEpochMismatch();
    } else {
      throw nextEpochMismatch();
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
    // The session signs the card first, and its signature must recover to the stored owner keys:
    // that is what binds the session handed to advanceEpoch to this agent's owner.
    const signed = await this.#issue(next, input, name, relays, now);
    const text = storedCardText(signed);
    // M1-4d-f: the current card joins the history. A card stored before M1-4d-d gets its `cardPop`
    // now, while the KeyStore is still at its epoch (04 §2.9); after the advance it no longer can.
    const oldCardPop =
      oldStored.cardPop ?? (control !== undefined ? await this.#signCardPop(oldStored.card) : null);
    const history = [...oldStored.history, { ...oldStored, cardPop: oldCardPop }].map(storedOf);
    // Every write is a compare-and-set on the epoch the card was issued from.
    const where = { agent_id: old.agentId, key_epoch: old.keyEpoch, revoked_at: null };

    if (control !== undefined) {
      // 1. Store the owner-signed next card as pending.
      const sealedPending = await seal(ctx, 'identity', 'pending_card_json', key, text);
      await ctx.store.transaction((tx) => {
        assertNotRevoked(tx, old.agentId);
        if (tx.update('identity', where, { pending_card_json: sealedPending }) !== 1) {
          throw concurrentRotation();
        }
      });
      // 2. Advance the KeyStore: compare-and-set on the stored epoch, with the owner session.
      try {
        await control.advanceEpoch(old.keyEpoch, input.owner);
      } catch (error) {
        if (isEpochConflict(error)) throw concurrentRotation();
        // The owner is told this rotation failed, so its pending card must never finish later,
        // after an advance from elsewhere (IR-M1-1g-d-1 L-1). Best effort, and only exactly this
        // card: if the advance did happen, a cleared card leaves `rotation_pending`, which is safe.
        await ctx.store
          .transaction((tx) =>
            tx.update(
              'identity',
              { ...where, pending_card_json: sealedPending },
              {
                pending_card_json: null,
              },
            ),
          )
          .catch(() => undefined);
        throw error;
      }
      // The control must have advanced this client's own KeyStore, to exactly the signed keys.
      if (!sameAgentKeys(await ctx.keyStore.getPublicBundle(), signed.card)) {
        throw nextEpochMismatch();
      }
    }
    // 04 §2.9 (D-102): the KeyStore is at the new epoch now, so its Nostr key signs the card.
    const cardPop = signed.cardPop ?? (await this.#signCardPop(signed.card));
    const sealedCard = await seal(
      ctx,
      'identity',
      'agent_card_json',
      key,
      ownCardText({ ...signed, cardPop }, history),
    );

    // 3. Commit the card and key_epoch, and clear the pending card.
    const patch = {
      agent_card_json: sealedCard,
      pending_card_json: null,
      key_epoch: next.keyEpoch,
      updated_at: now,
    };
    await ctx.store.transaction((tx) => {
      assertNotRevoked(tx, old.agentId);
      if (tx.update('identity', where, patch) !== 1) throw concurrentRotation();
    });
    ctx.log.info('identity rotated', { keyEpoch: next.keyEpoch });
    return this.#view({ ...current.row, ...patch }, false);
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
  ): Promise<StoredCard & { readonly cardAgentSig: string }> {
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
    // 04 §2.9 (D-102): `cardPop` now when the KeyStore is at the card's epoch (init, or a rotation
    // whose KeyStore already advanced); otherwise the rotation signs it after the advance.
    const current = await this.#ctx.keyStore.getPublicBundle();
    const cardPop = sameAgentKeys(current, card) ? await this.#signCardPop(card) : null;
    return { card, cardSig, cardAgentSig, cardPop };
  }
}

function nextEpochMismatch(): CoreError {
  return new CoreError(
    'key_epoch_mismatch',
    'The key store is not at the next key epoch for this agent.',
  );
}

function concurrentRotation(): CoreError {
  return new CoreError(
    'key_epoch_mismatch',
    'The identity changed while the new card was issued. Try again.',
  );
}

function isEpochConflict(error: unknown): boolean {
  return error instanceof KeyStoreError && error.code === 'epoch_conflict';
}

function assertNotRevoked(tx: StoreTx, agentId: string): void {
  if (tx.get('revoked_agents', { agent_evm: agentId }) !== undefined) {
    throw new CoreError('identity_revoked', 'This agent has been revoked by its owner.');
  }
}

/** True when the card names exactly the KeyStore's agent keys at the card's epoch. */
function sameAgentKeys(bundle: PublicIdentity, card: AgentCard): boolean {
  return (
    bundle.agentId === card.agentEvm &&
    bundle.keyEpoch === card.keyEpoch &&
    encodeHex0x(bundle.agentNostr) === card.agentNostr &&
    encodeHex0x(bundle.agentEnc) === card.agentEnc
  );
}

/**
 * The stored pending card if it finishes a rotation to the KeyStore's epoch, else undefined. It must
 * open and verify (cardSig and cardAgentSig), be for the stored epoch + 1, not have expired, name
 * exactly the KeyStore's keys at that epoch, and keep the current card's owner keys, name and relays.
 */
async function usablePendingCard(
  ctx: CoreContext,
  row: Row<'identity'>,
  sealed: Sealed,
  bundle: PublicIdentity,
  now: number,
): Promise<StoredCard | undefined> {
  const key = [row.agent_id];
  try {
    const pending = parseStoredCard(await open(ctx, 'identity', 'pending_card_json', key, sealed));
    const current = parseStoredCard(
      await open(ctx, 'identity', 'agent_card_json', key, row.agent_card_json),
    ).card;
    const usable =
      pending.cardAgentSig !== null &&
      current.agentEvm === row.agent_id &&
      current.keyEpoch === row.key_epoch &&
      pending.card.keyEpoch === row.key_epoch + 1 &&
      // An expired card never finishes a rotation (IR-M1-1g-d-1 L-1).
      (pending.card.expiresAt === 0 || pending.card.expiresAt > now) &&
      sameAgentKeys(bundle, pending.card) &&
      sameOwnerKeys(current, pending.card) &&
      pending.card.nameHash === current.nameHash &&
      pending.card.relaysHash === current.relaysHash;
    return usable ? pending : undefined;
  } catch (error) {
    if (error instanceof CoreError) return undefined;
    throw error;
  }
}

/**
 * On open (AgentLinkClient.create; M1-1g-d, IR-M1-7a-1 Q1). When the KeyStore is one epoch ahead of
 * the stored identity and the pending card is signed by the stored owner for exactly the KeyStore's
 * keys, the rotation finishes without a new owner signature: the owner signed that card before the
 * KeyStore advanced. Otherwise nothing changes, and with the KeyStore ahead the identity stays
 * `rotation_pending` (no send) until the owner runs rotate again. A revoked agent never finishes.
 *
 * It never fails the open (IR-M1-1g-d-1 L-2): on any error nothing is committed, the client still
 * opens to read history, and with the KeyStore ahead it refuses to send (`rotation_pending`).
 */
export async function finishPendingRotation(ctx: CoreContext): Promise<void> {
  try {
    await finishIfUsable(ctx);
  } catch {
    // A fixed message only: the error may carry store or cipher details.
    ctx.log.warn('pending rotation not finished');
  }
}

async function finishIfUsable(ctx: CoreContext): Promise<void> {
  const got = await readIdentity(ctx);
  if (got === undefined || got.revoked) return;
  const { row } = got;
  const sealed = row.pending_card_json;
  if (sealed === null) return;
  const bundle = await ctx.keyStore.getPublicBundle();
  if (bundle.agentId !== row.agent_id || bundle.keyEpoch !== row.key_epoch + 1) return;
  const now = nowOf(ctx);
  const pending = await usablePendingCard(ctx, row, sealed, bundle, now);
  if (pending === undefined) {
    ctx.log.warn('pending rotation card not usable', { keyEpoch: row.key_epoch });
    return;
  }
  // 04 §2.9 (D-102): the KeyStore is at the pending card's epoch, so its Nostr key signs `cardPop`.
  const cardPop = pending.cardPop ?? (await ctx.keyStore.signCardPop(pending.card));
  if (!verifyCardPop(pending.card, cardPop)) throw cardPopInvalid();
  // M1-4d-f: the current card joins the history (its `cardPop` as stored: the KeyStore has moved).
  const current = await openOwnCard(ctx, row);
  if (current === undefined) {
    ctx.log.warn('pending rotation not finished: the stored card does not match', {
      keyEpoch: row.key_epoch,
    });
    return;
  }
  const history = [...current.history, current].map(storedOf);
  const sealedCard = await seal(
    ctx,
    'identity',
    'agent_card_json',
    [row.agent_id],
    ownCardText({ ...pending, cardPop }, history),
  );
  const finished = await ctx.store.transaction((tx) => {
    if (isRevoked(tx, row)) return false;
    // Exactly the row and the pending card that were verified; otherwise another flow moved on.
    const where = {
      agent_id: row.agent_id,
      key_epoch: row.key_epoch,
      revoked_at: null,
      pending_card_json: sealed,
      agent_card_json: row.agent_card_json,
    };
    const patch = {
      agent_card_json: sealedCard,
      pending_card_json: null,
      key_epoch: bundle.keyEpoch,
      updated_at: now,
    };
    return tx.update('identity', where, patch) === 1;
  });
  if (finished) ctx.log.info('identity rotation finished', { keyEpoch: bundle.keyEpoch });
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
