// W4-RENAME-REACHES-CONTACTS (S2; D-141; 04 §2.5.1 `agent.label`, §2.6, §3.4.1, §3.6.1; 07 §3
// "Former name", §4.3; 08 §1): a rename is a key rotation.
//
// Real cores on both sides; the envelopes travel as the sender stored them (the relay spy records
// each publish and the receiver gets the stored envelope, as the in-memory relay would hand it on).
//
// - Rename. `identity.rotate({name})` issues the card for keyEpoch + 1 with the new `nameHash`
//   (owner-signed, the same EVM key, relays and owner keys), and the existing card-update sender
//   carries it to every contact. The contact shows the new name with the former one once.
// - Order. Of several renames the highest epoch wins whatever order the copies arrive in; an older
//   card is never applied again (strictly greater keyEpoch).
// - Limit. At most 3 renames that rotate per agent in any rolling 24 h (store-held cost bound): the
//   4th is refused (`rename_limited`) with the time it is allowed again.
// - Safety code. A rename changes neither the safety code nor "Safety code checked".
// - Catch-up. A contact that still encrypts to a superseded key of this agent is sent the current card
//   again, at most once per contact per 24 h.
// - Another process. A second client on the same store whose KeyStore is still at the old epoch never
//   sends under it (`key_epoch_mismatch`).
import {
  encodeBase64url,
  encodeHex,
  randomBytes,
  type Envelope,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { CoreError } from './errors.js';
import type { InboundReport } from './envelopes.js';
import { RENAMES_PER_DAY } from './identity.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
  RELAYS,
} from './testing/fixtures.js';
import { giftWrapId, pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const DAY = 86_400;

class RelaySpy {
  readonly published: NostrEvent[] = [];
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push(event);
      return Promise.resolve({
        results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...relays],
        sent: true,
      } as PublishOutcome);
    },
    sync: () =>
      Promise.resolve({
        partial: false,
        delivered: 0,
        duplicates: 0,
        dropped: 0,
        deferred: 0,
        relays: [],
      }),
  });
}

interface Agent extends TestAgent {
  readonly mark: MemoryPolicyMark;
  readonly memoryOwner: MemoryOwnerKeyStore;
}

let clock: FakeClock;

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<Agent> {
  const mark = new MemoryPolicyMark();
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n));
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: new RelaySpy().factory,
    policyMark: mark,
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return {
    client,
    store,
    cipher,
    keyStore,
    owner: owner as unknown as TestOwner,
    id: client.agentId,
    mark,
    memoryOwner: owner,
  };
}

/** The rename gesture's core part: the owner signs the next card with the new name (04 §2.6). */
async function renameTo(x: Agent, name: string): Promise<void> {
  const owner = await x.memoryOwner.unlock(passphrase());
  try {
    await x.client.identity.rotate({
      owner,
      ownerKeys: await x.memoryOwner.getPublicKeys(),
      epochControl: x.memoryOwner.epochControl(x.keyStore as MemoryKeyStore),
      name,
    });
  } finally {
    await owner.close();
  }
}

async function deliver(to: TestAgent, envelope: unknown): Promise<InboundReport[]> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status !== 'verified') return [received.report];
  return to.client.envelopes.processReceived();
}

/** The stored outbound card-updates of `from` to `to`, oldest first. */
async function cardUpdatesTo(from: TestAgent, to: TestAgent): Promise<Envelope[]> {
  const rows = await from.store.transaction((tx) =>
    tx.select(
      'envelopes',
      { direction: 'out', type: 'card-update', contact_id: to.id },
      { orderBy: [['created_at', 'asc']] },
    ),
  );
  return rows.map((row) => JSON.parse(row.envelope_json ?? 'null') as Envelope);
}

/** Sends the pending card-updates of `from` and hands the newest one for `to` to `to`. */
async function announce(from: Agent, to: Agent): Promise<InboundReport[]> {
  await from.client.sendCardUpdates();
  const all = await cardUpdatesTo(from, to);
  const last = all.at(-1);
  if (last === undefined) throw new Error('test: no card-update');
  return deliver(to, last);
}

const contactOf = (x: TestAgent, id: string) => x.client.contacts.get(id);

/** `from` sends `to` a text message; returns the stored envelope as it went out. */
async function say(from: TestAgent, to: TestAgent, text: string): Promise<unknown> {
  const sent = await from.client.sendMessage({ to: to.id, text });
  if (sent.status !== 'ok') throw new Error('test: not sent');
  const row = await from.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: sent.envelopeId }),
  );
  return JSON.parse(row?.envelope_json ?? 'null') as unknown;
}

const ownerA = new MemoryOwnerKeyStore(seed(171), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(172), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(173), passphrase());

let a: Agent;
let b: Agent;
let c: Agent;

beforeEach(async () => {
  clock = new FakeClock();
  a = await agent(71, ownerA, 'Alice');
  b = await agent(72, ownerB, 'Bob');
  c = await agent(73, ownerC, 'Carol');
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  await pairWith(clock, a, c);
  await pairWith(clock, c, a);
});

describe('a rename is a rotation (D-141; 04 §2.6)', () => {
  it('signs the next card with the new name; keys rotate, EVM key, relays and owner stay', async () => {
    const before = await a.client.identity.signedCard();
    expect(await a.client.identity.cardName()).toBe('Alice');
    clock.t += 10;
    await renameTo(a, 'Alicia');
    const after = await a.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(before.card.keyEpoch + 1);
    expect(after.name).toBe('Alicia');
    expect(after.card.nameHash).not.toBe(before.card.nameHash);
    expect(after.card.agentNostr).not.toBe(before.card.agentNostr);
    expect(after.card.agentEvm).toBe(before.card.agentEvm);
    expect(after.card.relaysHash).toBe(before.card.relaysHash);
    expect(after.card.ownerEvm).toBe(before.card.ownerEvm);
    expect(await a.client.identity.cardName()).toBe('Alicia');
    expect(await a.client.identity.sendState()).toBe('ready');
  });

  it('a rotation without a name keeps the name (not a rename)', async () => {
    const owner = await ownerA.unlock(passphrase());
    await a.client.identity.rotate({
      owner,
      ownerKeys: await ownerA.getPublicKeys(),
      epochControl: ownerA.epochControl(a.keyStore as MemoryKeyStore),
    });
    expect(await a.client.identity.cardName()).toBe('Alice');
    expect(await a.client.identity.renameAllowance()).toEqual({ status: 'ok', left: 3 });
  });

  it('refuses a name the card rule refuses, before anything changes', async () => {
    const owner = await ownerA.unlock(passphrase());
    await expect(
      a.client.identity.rotate({
        owner,
        ownerKeys: await ownerA.getPublicKeys(),
        epochControl: ownerA.epochControl(a.keyStore as MemoryKeyStore),
        name: '',
      }),
    ).rejects.toMatchObject({ code: 'name_invalid' });
    expect((await a.client.identity.get())?.keyEpoch).toBe(0);
  });
});

describe('the contact sees the new name, once with the former one (07 §3; 08 §1)', () => {
  it('rename → card-update → the contact shows the new name and "was" the old', async () => {
    await renameTo(a, 'Alicia');
    const reports = await announce(a, b);
    expect(reports.map((r) => r.outcome)).toEqual(['ok']);
    const seen = await contactOf(b, a.id);
    expect(seen.keyEpoch).toBe(1);
    expect(seen.name.value).toBe('Alicia');
    expect(seen.display.name).toBe('Alicia');
    expect(seen.nameChange?.formerName).toBe('Alice');
    // Activity: "{old} is now called {new}" (it stays after the note was seen).
    await b.client.contacts.markNameChangeSeen(a.id);
    const feed = await b.client.activity.list({ limit: 20 });
    expect(feed.items.find((e) => e.kind === 'contact_renamed')).toMatchObject({
      kind: 'contact_renamed',
      contactId: a.id,
      formerName: 'Alice',
      newName: 'Alicia',
    });
    // Every contact is told, not only one.
    expect((await announce(a, c)).map((r) => r.outcome)).toEqual(['ok']);
    expect((await contactOf(c, a.id)).nameChange?.formerName).toBe('Alice');
  });

  it('the note keeps the last seen name over two renames, then shows the next one', async () => {
    await renameTo(a, 'Alicia');
    await announce(a, b);
    await renameTo(a, 'Ally');
    await announce(a, b);
    const twice = await contactOf(b, a.id);
    expect(twice.name.value).toBe('Ally');
    // Not seen yet: still the name the owner last saw.
    expect(twice.nameChange?.formerName).toBe('Alice');
    expect(await b.client.contacts.markNameChangeSeen(a.id)).toBe(true);
    expect((await contactOf(b, a.id)).nameChange).toBeUndefined();
    await renameTo(a, 'Alison');
    await announce(a, b);
    expect((await contactOf(b, a.id)).nameChange?.formerName).toBe('Ally');
  });

  it('the former name is shown under the name rule (restricted)', async () => {
    await renameTo(a, 'Alicia');
    await announce(a, b);
    const seen = await contactOf(b, a.id);
    expect(seen.nameChange?.formerName).toBe('Alice');
    expect(typeof seen.nameChange?.at).toBe('number');
  });

  it('a card-update that keeps the name leaves no note', async () => {
    const owner = await ownerA.unlock(passphrase());
    await a.client.identity.rotate({
      owner,
      ownerKeys: await ownerA.getPublicKeys(),
      epochControl: ownerA.epochControl(a.keyStore as MemoryKeyStore),
    });
    await announce(a, b);
    const seen = await contactOf(b, a.id);
    expect(seen.keyEpoch).toBe(1);
    expect(seen.nameChange).toBeUndefined();
  });
});

describe('a contact shown by the owner alias: "Now calls itself {new} (was {old})" (08 §1)', () => {
  it('the alias stays; the note names the contact own old and new names', async () => {
    // B's owner calls A "Boss" (contact.rename), signed and applied as the app does.
    const prepared = await b.client.ownerActions.prepareContactRename(a.id, 'Boss');
    if (prepared.status !== 'prepared') throw new Error('test: rename not prepared');
    const session = await ownerB.unlock(passphrase());
    const body = prepared.body as unknown as JsonObject;
    const sig = await session.signOwnerAction(body);
    await session.close();
    expect((await b.client.ownerActions.apply({ body, sig })).status).toBe('applied');
    expect((await contactOf(b, a.id)).display.name).toBe('Boss');

    await renameTo(a, 'Alicia');
    await announce(a, b);
    const seen = await contactOf(b, a.id);
    expect(seen.display.name).toBe('Boss');
    expect(seen.name.source).toBe('owner');
    expect(seen.nameChange).toMatchObject({ formerName: 'Alice', newName: 'Alicia' });
    expect(seen.safetyCodeChecked).toBe(false);
    // A second rename keeps the last seen former name and moves the new one.
    await renameTo(a, 'Ally');
    await announce(a, b);
    expect((await contactOf(b, a.id)).nameChange).toMatchObject({
      formerName: 'Alice',
      newName: 'Ally',
    });
  });
});

describe('order: strictly greater keyEpoch (04 §3.4.1)', () => {
  it('the highest epoch wins whatever the arrival order; an old card is never applied again', async () => {
    await renameTo(a, 'Alicia');
    await a.client.sendCardUpdates();
    await renameTo(a, 'Ally');
    await a.client.sendCardUpdates();
    const [first, second] = await cardUpdatesTo(a, b);
    if (first === undefined || second === undefined) throw new Error('test: two card-updates');
    // The newer one arrives first.
    expect((await deliver(b, second)).map((r) => r.outcome)).toEqual(['ok']);
    expect((await contactOf(b, a.id)).name.value).toBe('Ally');
    // The older one arrives later: refused, the name stays.
    const late = await deliver(b, first);
    expect(late.map((r) => r.outcome)).not.toContain('ok');
    const now = await contactOf(b, a.id);
    expect(now.keyEpoch).toBe(2);
    expect(now.name.value).toBe('Ally');
    // A replay of the newest is not applied twice either.
    const replay = await deliver(b, second);
    expect(replay.map((r) => r.outcome)).not.toContain('ok');
    expect((await contactOf(b, a.id)).keyEpoch).toBe(2);
  });
});

describe('the rename limit: 3 per agent per rolling 24 h (Decision 46)', () => {
  it(`allows ${RENAMES_PER_DAY}, refuses the next with the time it is allowed again`, async () => {
    expect(RENAMES_PER_DAY).toBe(3);
    const firstAt = clock.t;
    await renameTo(a, 'One');
    clock.t += 60;
    await renameTo(a, 'Two');
    clock.t += 60;
    expect(await a.client.identity.renameAllowance()).toEqual({ status: 'ok', left: 1 });
    await renameTo(a, 'Three');
    clock.t += 60;
    expect(await a.client.identity.renameAllowance()).toEqual({
      status: 'limited',
      retryAt: firstAt + DAY,
    });
    const before = (await a.client.identity.get())?.keyEpoch;
    await expect(renameTo(a, 'Four')).rejects.toMatchObject({ code: 'rename_limited' });
    // Refused before anything changed.
    expect((await a.client.identity.get())?.keyEpoch).toBe(before);
    expect(await a.client.identity.cardName()).toBe('Three');
    // A day after the first, one is allowed again.
    clock.t += DAY - 180;
    expect(await a.client.identity.renameAllowance()).toEqual({ status: 'ok', left: 1 });
    await renameTo(a, 'Four');
    expect(await a.client.identity.cardName()).toBe('Four');
  });
});

describe('the safety code does not change (04 §2.6, §3.6.1; IR M1)', () => {
  it('keeps the code and "Safety code checked" after a rename', async () => {
    const before = await b.client.pairing.ownerSafetyCode(a.id);
    if (before.status !== 'ok') throw new Error('test: no safety code');
    // B's owner checked the code.
    const body: JsonObject = {
      v: 1,
      agent: b.id,
      owner: encodeHex((await ownerB.getPublicKeys()).ownerNostr),
      op: 'contact.check',
      params: { contact: a.id, pairingDigest: before.pairingDigest },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    };
    const session = await ownerB.unlock(passphrase());
    const sig = await session.signOwnerAction(body);
    await session.close();
    const applied = await b.client.contacts.applyContactCheck({ body, sig });
    expect(applied.status).toBe('applied');
    expect((await contactOf(b, a.id)).safetyCodeChecked).toBe(true);

    await renameTo(a, 'Alicia');
    await announce(a, b);
    const after = await b.client.pairing.ownerSafetyCode(a.id);
    if (after.status !== 'ok') throw new Error('test: no safety code after the rename');
    expect(after.pairingDigest).toBe(before.pairingDigest);
    const seen = await contactOf(b, a.id);
    expect(seen.name.value).toBe('Alicia');
    expect(seen.safetyCodeChecked).toBe(true);
    expect(seen.display.label).toBe('safety-code-checked');
  });
});

describe('catch-up: a contact still on a superseded key gets the card again (D-141 (6))', () => {
  it('resends once per contact per 24 h, only after a message to an old key', async () => {
    await renameTo(a, 'Alicia');
    // The card-update to B is stored and published, but B never receives it.
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 2, failed: 0 });
    expect(await cardUpdatesTo(a, b)).toHaveLength(1);
    clock.t += DAY + 60;
    // Nothing from B yet: nothing to catch up.
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
    // B writes to A's old keys (B still holds the epoch-0 card).
    const reports = await deliver(a, await say(b, a, 'hi'));
    expect(reports.map((r) => r.outcome)).toEqual(['ok']);
    // A sends B the current card again, once.
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 1, failed: 0 });
    expect(await cardUpdatesTo(a, b)).toHaveLength(2);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
    // Another stale message within 24 h: no second resend.
    clock.t += 3_600;
    await deliver(a, await say(b, a, 'still there?'));
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
    // C was never on an old key after its card-update: nothing for C.
    expect(await cardUpdatesTo(a, c)).toHaveLength(1);
    // After the newest card reached B, B's messages use the new key: no resend later.
    const [, resent] = await cardUpdatesTo(a, b);
    await deliver(b, resent);
    clock.t += DAY + 60;
    await deliver(a, await say(b, a, 'ok'));
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
  });
});

describe('an interrupted rename finishes on the next open (04 §2.6; identity.ts finishPendingRotation)', () => {
  it('pending card with the new name + KeyStore advanced → the next open commits card and name', async () => {
    const owner = new MemoryOwnerKeyStore(seed(174), passphrase());
    const inner = new MemoryKeyStore(seed(74));
    // The KeyStore the client uses; `failPop` breaks the step right after the epoch advance.
    let failPop = false;
    const keyStore: KeyStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'signCardPop' && failPop) {
          return () => Promise.reject(new Error('test: interrupted after the advance'));
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const store = new MemoryStore();
    const cipher = new TestStoreCipher();
    const mark = new MemoryPolicyMark();
    const open = () =>
      AgentLinkClient.create({
        keyStore,
        store,
        cipher,
        approvals: new RecordingApprovalChannel(),
        clock: clock.now,
        transport: new RelaySpy().factory,
        policyMark: mark,
      });
    const first = await open();
    await first.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'Dora',
      relays: RELAYS,
    });
    failPop = true;
    const session = await owner.unlock(passphrase());
    await expect(
      first.identity.rotate({
        owner: session,
        ownerKeys: await owner.getPublicKeys(),
        epochControl: owner.epochControl(inner),
        name: 'Dorothy',
      }),
    ).rejects.toThrow();
    await session.close();
    // Interrupted: the KeyStore is at epoch 1, the store still at 0 with the pending card.
    expect((await inner.getPublicBundle()).keyEpoch).toBe(1);
    expect((await first.identity.get())?.keyEpoch).toBe(0);
    expect(await first.identity.sendState()).toBe('rotation_pending');
    expect(await first.identity.cardName()).toBe('Dora');
    // The next open finishes it with the name the owner signed.
    failPop = false;
    const next = await open();
    expect((await next.identity.get())?.keyEpoch).toBe(1);
    expect(await next.identity.cardName()).toBe('Dorothy');
    const card = await next.identity.signedCard();
    expect(card.name).toBe('Dorothy');
    expect(card.card.keyEpoch).toBe(1);
    expect(await next.identity.sendState()).toBe('ready');
  });
});

describe('another process on the same agent never sends under the old epoch (08 §1)', () => {
  it('a client whose KeyStore is still at the old epoch refuses to send', async () => {
    // A second process (an AI app's `agentlink mcp`) on A's store, its KeyStore at epoch 0.
    const second = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(71)),
      store: a.store,
      cipher: a.cipher,
      approvals: new RecordingApprovalChannel(),
      clock: clock.now,
      transport: new RelaySpy().factory,
      policyMark: a.mark,
    });
    await renameTo(a, 'Alicia');
    expect(await second.identity.sendState()).toBe('key_epoch_mismatch');
    await expect(second.sendMessage({ to: b.id, text: 'old key?' })).rejects.toBeInstanceOf(
      CoreError,
    );
    const fromOld = await a.store.transaction((tx) =>
      tx
        .select('envelopes', { direction: 'out', type: 'text' })
        .filter((r) => r.contact_id === b.id),
    );
    expect(fromOld).toHaveLength(0);
  });
});
