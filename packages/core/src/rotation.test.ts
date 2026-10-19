// M1-1g-d (IR-M1-7a-1 Q1, L-1): the rotation flow over the KeyStore's owner-only epoch advance.
// Order: preview epoch + 1, sign the N + 1 card, store it as pending, advance the KeyStore with a
// compare-and-set, then commit key_epoch. A crash at each step leaves a state that either finishes
// or refuses to send, never one that sends under a key no contact knows (04 §2.6, I-1, I-4).
import {
  KeyStoreError,
  agentCardNameHash,
  agentCardRelaysHash,
  encodeHex0x,
  verifyAgentCard,
  type AgentCard,
  type KeyEpochControl,
  type OwnerSession,
  type PublicIdentity,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { cardTypedData, parseStoredCard, storedCardText } from './card.js';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import { MemoryStore } from './store/memory-store.js';
import type { Sealed } from './store/schema.js';
import { rowKeyOf, type SealContext, type Store, type StoreTx } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';

/** A Store whose transactions fail (and roll back) on a chosen update: a crash at that commit. */
class CrashingStore implements Store {
  crashOn: ((table: string, patch: Record<string, unknown>) => boolean) | undefined;
  readonly inner: MemoryStore;

  constructor(inner: MemoryStore) {
    this.inner = inner;
  }

  get schemaVersion(): number {
    return this.inner.schemaVersion;
  }

  transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    return this.inner.transaction((tx) => {
      const crashOn = this.crashOn;
      const wrapped = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'update') {
            return (table: string, where: unknown, patch: Record<string, unknown>) => {
              if (crashOn?.(table, patch) === true) throw new Error('simulated crash');
              return (target.update as (...a: unknown[]) => number)(table, where, patch);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
      return body(wrapped);
    });
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** A TestStoreCipher that runs a one-shot hook before sealing `agent_card_json`. */
class HookCipher extends TestStoreCipher {
  onCardSeal: (() => Promise<void>) | undefined;

  override async seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const hook = this.onCardSeal;
    if (hook !== undefined && context.column === 'agent_card_json') {
      this.onCardSeal = undefined;
      await hook();
    }
    return super.seal(context, plaintext);
  }
}

/** The commit of a rotation: the identity update that sets key_epoch. */
const keyEpochCommit = (table: string, patch: Record<string, unknown>): boolean =>
  table === 'identity' && 'key_epoch' in patch;

async function setup(options: { agentSeed?: number; ownerSeed?: number } = {}) {
  const keyStore = new MemoryKeyStore(seed(options.agentSeed ?? 1), { keyEpoch: 0 });
  const owner = new MemoryOwnerKeyStore(seed(options.ownerSeed ?? 101), passphrase());
  const store = new CrashingStore(new MemoryStore());
  const cipher = new HookCipher();
  const clock = new FakeClock();
  // The control is a separate object, made on the owner side (IR-M1-1g-d-1 M-1).
  const control = owner.epochControl(keyStore);
  const open = (keys = keyStore) =>
    AgentLinkClient.create({
      keyStore: keys,
      store,
      cipher,
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
    });
  const client = await open();
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: 'n',
    relays: RELAYS,
  });
  const rotateInput = async (epochControl: KeyEpochControl = control, expiresAt?: number) => ({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    epochControl,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  return { keyStore, owner, control, store, cipher, clock, client, open, rotateInput };
}

async function identityRow(store: Store) {
  const row = await store.transaction((tx) => tx.select('identity')[0]);
  if (row === undefined) throw new Error('no identity row');
  return row;
}

/** The pending card as stored (sealed for identity.pending_card_json). */
async function pendingCard(store: Store, cipher: TestStoreCipher) {
  const row = await identityRow(store);
  const sealed = row.pending_card_json;
  if (sealed === null) return null;
  const text = await cipher.open(
    { table: 'identity', column: 'pending_card_json', rowKey: rowKeyOf([row.agent_id]) },
    sealed,
  );
  return parseStoredCard(text);
}

/** A control that delegates, with a hook before the advance (and optionally the preview). */
function controlWith(
  inner: KeyEpochControl,
  beforeAdvance: (expected: number, owner: OwnerSession) => Promise<void>,
  beforePreview: (epoch: number) => Promise<void> = () => Promise.resolve(),
): KeyEpochControl & { advances: number } {
  const control = {
    advances: 0,
    previewEpoch: async (epoch: number): Promise<PublicIdentity> => {
      await beforePreview(epoch);
      return inner.previewEpoch(epoch);
    },
    advanceEpoch: async (expected: number, owner: OwnerSession): Promise<PublicIdentity> => {
      control.advances += 1;
      await beforeAdvance(expected, owner);
      return inner.advanceEpoch(expected, owner);
    },
  };
  return control;
}

/**
 * Starts a rotation whose advance never returns: a process crash just before the advance. Resolves
 * once the pending card is stored and the advance was reached; nothing after it runs.
 */
async function crashBeforeAdvance(
  s: Awaited<ReturnType<typeof setup>>,
  expiresAt?: number,
): Promise<void> {
  let reached: () => void = () => undefined;
  const atAdvance = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hang = controlWith(s.control, () => {
    reached();
    return new Promise<void>(() => undefined);
  });
  void s.client.identity.rotate(await s.rotateInput(hang, expiresAt));
  await atAdvance;
}

describe('identity.rotate with the epoch advance (M1-1g-d)', () => {
  it('previews, signs, stores pending, advances with compare-and-set, then commits', async () => {
    const s = await setup();
    const v0 = await s.client.identity.get();
    s.clock.t += 60;
    const v1 = await s.client.identity.rotate(await s.rotateInput());

    const bundle = await s.keyStore.getPublicBundle();
    expect(bundle.keyEpoch).toBe(1);
    expect(v1.keyEpoch).toBe(1);
    expect(v1.card.keyEpoch).toBe(1);
    expect(v1.card.agentNostr).toBe(encodeHex0x(bundle.agentNostr));
    expect(v1.card.agentEnc).toBe(encodeHex0x(bundle.agentEnc));
    expect(v1.card.agentNostr).not.toBe(v0?.card.agentNostr);
    expect(verifyAgentCard(v1.card, v1.cardSig, v1.cardAgentSig)).toBe(true);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
    expect(await s.client.identity.sendState()).toBe('ready');
    // Old-epoch keys stay for decryption: the lookup still answers for epoch 0.
    expect((await s.keyStore.getPublicBundle({ epoch: 0 })).keyEpoch).toBe(0);
  });

  it('a crash before the advance: nothing changed for contacts, the agent still sends, a retry finishes', async () => {
    const s = await setup();
    await crashBeforeAdvance(s);

    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).key_epoch).toBe(0);
    // The owner-signed N + 1 card is stored as pending, nothing else.
    expect((await pendingCard(s.store, s.cipher))?.card.keyEpoch).toBe(1);
    expect(await s.client.identity.sendState()).toBe('ready');
    const reopened = await s.open();
    expect(await reopened.identity.sendState()).toBe('ready');
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);

    const v1 = await reopened.identity.rotate(await s.rotateInput());
    expect(v1.keyEpoch).toBe(1);
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(1);
    expect(await reopened.identity.sendState()).toBe('ready');
  });

  it('a crash after the advance, before the commit: refuses to send; the next open finishes without a new signature', async () => {
    const s = await setup();
    s.store.crashOn = keyEpochCommit;
    await expect(s.client.identity.rotate(await s.rotateInput())).rejects.toThrow(
      'simulated crash',
    );
    s.store.crashOn = undefined;

    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(1);
    expect((await identityRow(s.store)).key_epoch).toBe(0);
    const pending = await pendingCard(s.store, s.cipher);
    expect(pending?.card.keyEpoch).toBe(1);
    // The KeyStore is ahead of the stored card: no send under a key no contact knows.
    expect(await s.client.identity.sendState()).toBe('rotation_pending');
    await expect(s.client.identity.assertCanSend()).rejects.toMatchObject({
      code: 'rotation_pending',
    });

    // Reopening takes no owner session: the owner already signed the pending card.
    const reopened = await s.open();
    const view = await reopened.identity.get();
    expect(view?.keyEpoch).toBe(1);
    expect(view?.card).toEqual(pending?.card);
    expect(view?.cardSig).toBe(pending?.cardSig);
    expect(view?.cardAgentSig).toBe(pending?.cardAgentSig);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
    expect(await reopened.identity.sendState()).toBe('ready');
    // The first client sees the finished rotation too.
    expect(await s.client.identity.sendState()).toBe('ready');
  });

  it('a stale expected epoch (advanced elsewhere) fails the compare-and-set and commits nothing', async () => {
    const s = await setup();
    const race = controlWith(s.control, async (expected, owner) => {
      await s.control.advanceEpoch(expected, owner);
    });
    await expect(s.client.identity.rotate(await s.rotateInput(race))).rejects.toMatchObject({
      code: 'key_epoch_mismatch',
    });
    // The other advance went through once; this one changed nothing.
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(1);
    expect((await identityRow(s.store)).key_epoch).toBe(0);
    expect(await s.client.identity.sendState()).toBe('rotation_pending');
    // The stored pending card is owner-signed for exactly these keys: the next open finishes it.
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(1);
    expect(await reopened.identity.sendState()).toBe('ready');
  });

  it('concurrent rotations: one wins; the other fails the compare-and-set and changes nothing', async () => {
    const s = await setup();
    const inputs = [await s.rotateInput(), await s.rotateInput(), await s.rotateInput()];
    const results = await Promise.allSettled(inputs.map((i) => s.client.identity.rotate(i)));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toMatchObject({ code: 'key_epoch_mismatch' });
      }
    }
    const bundle = await s.keyStore.getPublicBundle();
    expect(bundle.keyEpoch).toBe(1);
    const view = await s.client.identity.get();
    expect(view?.keyEpoch).toBe(1);
    expect(view?.card.agentNostr).toBe(encodeHex0x(bundle.agentNostr));
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
    expect(await s.client.identity.sendState()).toBe('ready');
  });

  it('a replayed advance after a finished rotation fails the compare-and-set', async () => {
    const s = await setup();
    const session = await s.owner.unlock(passphrase());
    await s.client.identity.rotate(await s.rotateInput());
    await expect(s.control.advanceEpoch(0, session)).rejects.toMatchObject({
      code: 'epoch_conflict',
    });
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(1);
    // A second rotation is a new owner decision from the new epoch.
    const v2 = await s.client.identity.rotate(await s.rotateInput());
    expect(v2.keyEpoch).toBe(2);
    expect(await s.client.identity.sendState()).toBe('ready');
  });

  it('does not commit when the control advanced another backend than the KeyStore of this client', async () => {
    const s = await setup();
    const twin = new MemoryKeyStore(seed(1));
    await expect(
      s.client.identity.rotate(await s.rotateInput(s.owner.epochControl(twin))),
    ).rejects.toMatchObject({
      code: 'key_epoch_mismatch',
    });
    expect((await twin.getPublicBundle()).keyEpoch).toBe(1);
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).key_epoch).toBe(0);
    expect(await s.client.identity.sendState()).toBe('ready');
  });

  it('refuses a control over another agent before anything is signed, stored or advanced', async () => {
    const s = await setup();
    const other = new MemoryKeyStore(seed(2));
    await expect(
      s.client.identity.rotate(await s.rotateInput(s.owner.epochControl(other))),
    ).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
    expect((await other.getPublicBundle()).keyEpoch).toBe(0);
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
  });

  it('refuses a revoked agent before advancing', async () => {
    const s = await setup();
    await s.store.transaction((tx) => tx.update('identity', {}, { revoked_at: s.clock.t }));
    await expect(s.client.identity.rotate(await s.rotateInput())).rejects.toMatchObject({
      code: 'identity_revoked',
    });
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
  });

  it('refuses another owner session before advancing (the session signs the card first)', async () => {
    const s = await setup();
    const other = new MemoryOwnerKeyStore(seed(103), passphrase());
    await expect(
      s.client.identity.rotate({
        owner: await other.unlock(passphrase()),
        ownerKeys: await s.owner.getPublicKeys(),
        epochControl: s.control,
      }),
    ).rejects.toMatchObject({ code: 'card_owner_signature_invalid' });
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
  });
});

describe('opening with a pending rotation (M1-1g-d)', () => {
  /** Leaves the KeyStore at epoch 1 and the store at 0 with a pending card: the crash case. */
  async function crashedAfterAdvance(options: { agentSeed?: number; ownerSeed?: number } = {}) {
    const s = await setup(options);
    s.store.crashOn = keyEpochCommit;
    await expect(s.client.identity.rotate(await s.rotateInput())).rejects.toThrow();
    s.store.crashOn = undefined;
    return s;
  }

  it('does not finish a pending card that does not open; stays rotation_pending until the owner rotates', async () => {
    const s = await crashedAfterAdvance();
    await s.store.transaction((tx) =>
      tx.update('identity', {}, { pending_card_json: 'not-sealed' as Sealed }),
    );
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
    // The owner finishes it: the KeyStore is already at the next epoch, so no advance is needed.
    const control = controlWith(s.control, () => Promise.resolve());
    const v1 = await reopened.identity.rotate(await s.rotateInput(control));
    expect(control.advances).toBe(0);
    expect(v1.keyEpoch).toBe(1);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
    expect(await reopened.identity.sendState()).toBe('ready');
  });

  it("never finishes with a pending card signed by another owner, even for this agent's keys", async () => {
    const s = await crashedAfterAdvance();
    // The same agent seed under another owner: a card that verifies on its own.
    const foreign = await crashedAfterAdvance({ ownerSeed: 103 });
    const foreignPending = (await identityRow(foreign.store)).pending_card_json;
    expect(foreignPending).not.toBeNull();
    await s.store.transaction((tx) =>
      tx.update('identity', {}, { pending_card_json: foreignPending }),
    );
    const reopened = await s.open();
    const view = await reopened.identity.get();
    expect(view?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
  });

  it('never finishes with a pending card that names other keys, though both signatures verify', async () => {
    const s = await crashedAfterAdvance();
    const pending = await pendingCard(s.store, s.cipher);
    if (pending === null) throw new Error('no pending card');
    // The owner and agent keys sign any card they are given: one naming the epoch-5 keys instead.
    const elsewhere = await new MemoryKeyStore(seed(1), { keyEpoch: 5 }).getPublicBundle();
    const card = { ...pending.card, agentNostr: encodeHex0x(elsewhere.agentNostr) };
    const session = await s.owner.unlock(passphrase());
    const text = storedCardText({
      card,
      cardSig: await session.sign712(cardTypedData(card)),
      cardAgentSig: await s.keyStore.sign712(cardTypedData(card)),
      cardPop: null,
    });
    const row = await identityRow(s.store);
    const sealed = await s.cipher.seal(
      { table: 'identity', column: 'pending_card_json', rowKey: rowKeyOf([row.agent_id]) },
      text,
    );
    await s.store.transaction((tx) => tx.update('identity', {}, { pending_card_json: sealed }));
    expect(parseStoredCard(text).card.agentNostr).toBe(card.agentNostr);

    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
  });

  it('never finishes for a revoked agent', async () => {
    const s = await crashedAfterAdvance();
    await s.store.transaction((tx) => tx.update('identity', {}, { revoked_at: s.clock.t }));
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('revoked');
  });

  it('refuses to open a KeyStore two epochs ahead, pending card or not', async () => {
    const s = await crashedAfterAdvance();
    const session = await s.owner.unlock(passphrase());
    await s.control.advanceEpoch(1, session);
    await expect(s.open()).rejects.toMatchObject({ code: 'key_epoch_mismatch' });
    expect((await identityRow(s.store)).key_epoch).toBe(0);
  });

  it('keeps a stale pending card inert while the KeyStore is at the stored epoch', async () => {
    const s = await setup();
    await crashBeforeAdvance(s);
    expect((await identityRow(s.store)).pending_card_json).not.toBeNull();
    const reopened = await s.open(new MemoryKeyStore(seed(1), { keyEpoch: 0 }));
    const view = await reopened.identity.get();
    expect(view?.keyEpoch).toBe(0);
    expect(view?.card.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('ready');
  });
});

describe('KeyStoreError from the control is not swallowed', () => {
  it('passes owner_locked through when the session ended before the advance', async () => {
    const s = await setup();
    const input = await s.rotateInput();
    const ending = controlWith(s.control, async () => {
      await input.owner.close();
    });
    const rejected = await s.client.identity.rotate({ ...input, epochControl: ending }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(KeyStoreError);
    expect(rejected).toMatchObject({ code: 'owner_locked' });
    expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(0);
    expect((await identityRow(s.store)).key_epoch).toBe(0);
    expect(await s.client.identity.sendState()).toBe('ready');
  });
});

/** Writes an owner- and agent-signed pending card with `change` applied (signatures re-made). */
async function forgePending(
  s: Awaited<ReturnType<typeof setup>>,
  change: (card: AgentCard) => AgentCard,
  options: { readonly withoutAgentSig?: boolean } = {},
): Promise<void> {
  const pending = await pendingCard(s.store, s.cipher);
  if (pending === null) throw new Error('no pending card');
  const card = change(pending.card);
  const session = await s.owner.unlock(passphrase());
  const text = storedCardText({
    card,
    cardSig: await session.sign712(cardTypedData(card)),
    cardAgentSig:
      options.withoutAgentSig === true ? null : await s.keyStore.sign712(cardTypedData(card)),
    cardPop: null,
  });
  // Both signatures verify: the card is refused for what it says, not for its signatures.
  expect(parseStoredCard(text).card).toEqual(card);
  const row = await identityRow(s.store);
  const sealed = await s.cipher.seal(
    { table: 'identity', column: 'pending_card_json', rowKey: rowKeyOf([row.agent_id]) },
    text,
  );
  await s.store.transaction((tx) => tx.update('identity', {}, { pending_card_json: sealed }));
}

/** KeyStore at epoch 1, the store at 0 with a pending card: the crash after the advance. */
async function afterAdvance(s: Awaited<ReturnType<typeof setup>>, expiresAt?: number) {
  s.store.crashOn = keyEpochCommit;
  await expect(s.client.identity.rotate(await s.rotateInput(s.control, expiresAt))).rejects.toThrow(
    'simulated crash',
  );
  s.store.crashOn = undefined;
}

describe('review IR-M1-1g-d-1 fixes', () => {
  it('L-1: a failed advance clears the pending card, so an advance elsewhere never finishes it', async () => {
    const s = await setup();
    const input = await s.rotateInput();
    const ending = controlWith(s.control, async () => {
      await input.owner.close();
    });
    await expect(
      s.client.identity.rotate({ ...input, epochControl: ending }),
    ).rejects.toMatchObject({ code: 'owner_locked' });
    expect((await identityRow(s.store)).pending_card_json).toBeNull();

    // Something advances the KeyStore later: the owner was told the rotation failed.
    await s.control.advanceEpoch(0, await s.owner.unlock(passphrase()));
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
  });

  it('L-1: an expired pending card never finishes, even after the advance', async () => {
    const s = await setup();
    const expiresAt = s.clock.t + 100;
    await crashBeforeAdvance(s, expiresAt);
    expect((await pendingCard(s.store, s.cipher))?.card.expiresAt).toBe(expiresAt);
    await s.control.advanceEpoch(0, await s.owner.unlock(passphrase()));
    s.clock.t = expiresAt;
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
  });

  it('L-1: a pending card that has not expired yet still finishes', async () => {
    const s = await setup();
    const expiresAt = s.clock.t + 100;
    await afterAdvance(s, expiresAt);
    s.clock.t = expiresAt - 1;
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(1);
    expect(await reopened.identity.sendState()).toBe('ready');
  });

  it('L-2: a failure while finishing on open still opens the client, which refuses to send', async () => {
    const s = await setup();
    await afterAdvance(s);
    s.store.crashOn = keyEpochCommit;
    const reopened = await s.open();
    expect((await reopened.identity.get())?.keyEpoch).toBe(0);
    expect(await reopened.identity.sendState()).toBe('rotation_pending');
    await expect(reopened.identity.assertCanSend()).rejects.toMatchObject({
      code: 'rotation_pending',
    });
    // Once the store recovers, the next open finishes.
    s.store.crashOn = undefined;
    const again = await s.open();
    expect((await again.identity.get())?.keyEpoch).toBe(1);
    expect(await again.identity.sendState()).toBe('ready');
  });

  it('L-3: an advance elsewhere before the preview is key_epoch_mismatch, not a raw KeyStoreError', async () => {
    const s = await setup();
    const session = await s.owner.unlock(passphrase());
    const late = controlWith(
      s.control,
      () => Promise.resolve(),
      async (epoch) => {
        await s.control.advanceEpoch(epoch - 1, session);
      },
    );
    const rejected = await s.client.identity.rotate(await s.rotateInput(late)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(CoreError);
    expect(rejected).toMatchObject({ code: 'key_epoch_mismatch' });
    expect(late.advances).toBe(0);
    expect((await identityRow(s.store)).pending_card_json).toBeNull();
  });

  describe('L-4: every check of the finish path', () => {
    it('refuses a pending card with another name', async () => {
      const s = await setup();
      await afterAdvance(s);
      await forgePending(s, (card) => ({
        ...card,
        nameHash: encodeHex0x(agentCardNameHash('someone else')),
      }));
      const reopened = await s.open();
      expect((await identityRow(s.store)).key_epoch).toBe(0);
      expect(await reopened.identity.sendState()).toBe('rotation_pending');
    });

    it('refuses a pending card with other relays', async () => {
      const s = await setup();
      await afterAdvance(s);
      await forgePending(s, (card) => ({
        ...card,
        relaysHash: encodeHex0x(agentCardRelaysHash(['wss://relay.example.org'])),
      }));
      const reopened = await s.open();
      expect((await identityRow(s.store)).key_epoch).toBe(0);
      expect(await reopened.identity.sendState()).toBe('rotation_pending');
    });

    it('refuses a pending card without the agent signature', async () => {
      const s = await setup();
      await afterAdvance(s);
      await forgePending(s, (card) => card, { withoutAgentSig: true });
      const reopened = await s.open();
      expect((await identityRow(s.store)).key_epoch).toBe(0);
      expect(await reopened.identity.sendState()).toBe('rotation_pending');
    });

    it('refuses when the current card is not at the stored epoch', async () => {
      const s = await setup();
      const epoch0Card = (await identityRow(s.store)).agent_card_json;
      await s.client.identity.rotate(await s.rotateInput());
      // Rotating 1 -> 2 crashes after the advance; then the epoch-0 card is put back under epoch 1.
      await afterAdvance(s);
      expect((await s.keyStore.getPublicBundle()).keyEpoch).toBe(2);
      await s.store.transaction((tx) => tx.update('identity', {}, { agent_card_json: epoch0Card }));
      await s.open();
      const row = await identityRow(s.store);
      expect(row.key_epoch).toBe(1);
      expect(row.pending_card_json).not.toBeNull();
    });

    it('does not finish when the agent is revoked between the check and the commit', async () => {
      const s = await setup();
      await afterAdvance(s);
      const agentId = (await identityRow(s.store)).agent_id;
      s.cipher.onCardSeal = () =>
        s.store.transaction((tx) => {
          tx.insert('revoked_agents', {
            agent_evm: agentId,
            nostr_keys: '[]',
            signed_json: null,
            reason: null,
            source: 'envelope',
            chain_id: null,
            registry_ref: null,
            applied_at: s.clock.t,
          });
        });
      const reopened = await s.open();
      expect(s.cipher.onCardSeal).toBeUndefined();
      expect((await identityRow(s.store)).key_epoch).toBe(0);
      expect(await reopened.identity.sendState()).toBe('revoked');
    });

    it('does not commit when the pending card is replaced between the check and the commit', async () => {
      const s = await setup();
      await afterAdvance(s);
      const agentId = (await identityRow(s.store)).agent_id;
      const replacement = await s.cipher.seal(
        { table: 'identity', column: 'pending_card_json', rowKey: rowKeyOf([agentId]) },
        'replaced',
      );
      s.cipher.onCardSeal = () =>
        s.store.transaction((tx) => {
          tx.update('identity', {}, { pending_card_json: replacement });
        });
      const reopened = await s.open();
      expect(s.cipher.onCardSeal).toBeUndefined();
      const row = await identityRow(s.store);
      expect(row.key_epoch).toBe(0);
      expect(row.pending_card_json).toBe(replacement);
      expect(await reopened.identity.sendState()).toBe('rotation_pending');
    });
  });
});
