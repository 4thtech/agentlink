// RELAY-CARD-MIGRATION (S2; 04 §2.6, §3.4.1; 07 §4.3): the owner's relay migration is a rotation to
// keyEpoch + 1 with the migrated list; contacts learn it through card-update, which during the
// transition also goes to the legacy relays; afterwards the identity no longer needs the migration.
import { type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  DEFAULT_RELAYS,
  LEGACY_CARD_UPDATE_UNTIL,
  LEGACY_READ_RELAYS,
  wrapEnvelope,
  type PublishOutcome,
} from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const clock = new FakeClock();
const START = clock.t;
/** Which relays accept a publish; undefined: all of them. */
let acceptOnly: ((relay: string) => boolean) | undefined;
/** An install from before 0.5.13: its card lists the two legacy relays and one kept relay. */
const OLD_RELAYS = Object.freeze(['wss://nos.lol', 'wss://nostr.mom', 'wss://relay.example.org']);

interface Agent extends TestAgent {
  readonly published: { readonly kind: number; readonly relays: readonly string[] }[];
}

async function agent(n: number, owner: MemoryOwnerKeyStore, relays: readonly string[]) {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n), { nowSeconds: () => clock.now() });
  const published: Agent['published'] = [];
  const factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, to) => {
      published.push({ kind: event.kind, relays: [...to] });
      const ok = to.filter((relay) => acceptOnly === undefined || acceptOnly(relay));
      return Promise.resolve({
        results: to.map((relay) => ({
          relay,
          ok: ok.includes(relay),
          reason: ok.includes(relay) ? ('ok' as const) : ('connect_failed' as const),
        })),
        acked: ok,
        sent: ok.length > 0,
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
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: factory,
    policyMark: new MemoryPolicyMark(),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: `agent${n}`,
    relays,
  });
  const testOwner = owner as unknown as TestOwner;
  return { client, store, cipher, keyStore, owner: testOwner, id: client.agentId, published };
}

async function migrate(x: Agent, relays: readonly string[]): Promise<void> {
  await x.client.identity.rotate({
    owner: await x.owner.unlock(passphrase()),
    ownerKeys: await x.owner.getPublicKeys(),
    epochControl: x.owner.epochControl(x.keyStore),
    relays,
  });
}

/** The relays of the contact-role outbox rows of `x`'s card-updates. */
async function cardUpdateContactRelays(x: Agent): Promise<string[][]> {
  const rows = await x.store.transaction((tx) => {
    const ids = tx
      .select('envelopes', { direction: 'out', type: 'card-update' })
      .map((r) => r.envelope_id);
    return tx.select('outbox').filter((r) => ids.includes(r.envelope_id) && r.role === 'contact');
  });
  const out: string[][] = [];
  for (const row of rows) {
    const text = await x.cipher.open(
      { table: 'outbox', column: 'relays', rowKey: rowKeyOf([row.wrap_id]) },
      row.relays,
    );
    out.push(JSON.parse(text) as string[]);
  }
  return out;
}

/** The states of the contact-role outbox rows of `x`'s card-updates. */
async function cardUpdateContactStates(x: Agent): Promise<string[]> {
  return x.store.transaction((tx) => {
    const ids = tx
      .select('envelopes', { direction: 'out', type: 'card-update' })
      .map((r) => r.envelope_id);
    return tx
      .select('outbox')
      .filter((r) => ids.includes(r.envelope_id) && r.role === 'contact')
      .map((r) => r.state);
  });
}

const ownerA =new MemoryOwnerKeyStore(seed(171), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(172), passphrase());
let a: Agent;
let b: Agent;

beforeEach(async () => {
  clock.t = START;
  acceptOnly = undefined;
  a = await agent(71, ownerA, OLD_RELAYS);
  b = await agent(72, ownerB, [...DEFAULT_RELAYS]);
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
});

describe('identity.relayMigration (detection)', () => {
  it('an ID whose card lists a legacy relay needs the migration, with the migrated list', async () => {
    const got = await a.client.identity.relayMigration();
    expect(got.status).toBe('needed');
    if (got.status !== 'needed') return;
    expect(got.relays).toContain('wss://relay.example.org');
    for (const legacy of LEGACY_READ_RELAYS) expect(got.relays).not.toContain(legacy);
    for (const r of DEFAULT_RELAYS) expect(got.relays).toContain(r);
  });

  it('an ID on the new list needs nothing', async () => {
    expect(await b.client.identity.relayMigration()).toEqual({ status: 'current' });
  });
});

describe('rotate({relays}) (04 §2.6, 07 §4.3)', () => {
  it('issues the card for keyEpoch + 1 with the migrated list; the notice clears', async () => {
    const before = await a.client.identity.signedCard();
    const got = await a.client.identity.relayMigration();
    if (got.status !== 'needed') throw new Error('test: expected needed');
    await migrate(a, got.relays);
    const after = await a.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(before.card.keyEpoch + 1);
    expect(after.relays).toEqual(got.relays);
    expect(after.card.relaysHash).not.toBe(before.card.relaysHash);
    expect(await a.client.identity.relays()).toEqual(got.relays);
    expect(await a.client.identity.relayMigration()).toEqual({ status: 'current' });
  });

  it('refuses an invalid list before anything is signed', async () => {
    const before = await a.client.identity.signedCard();
    await expect(migrate(a, ['wss://only-one.example.org'])).rejects.toMatchObject({
      code: 'relays_invalid',
    });
    expect((await a.client.identity.signedCard()).card.keyEpoch).toBe(before.card.keyEpoch);
  });
});

describe('card-update after the migration', () => {
  it('goes to every contact, also published to the legacy relays during the transition', async () => {
    const got = await a.client.identity.relayMigration();
    if (got.status !== 'needed') throw new Error('test: expected needed');
    await migrate(a, got.relays);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 1, failed: 0 });
    const lists = await cardUpdateContactRelays(a);
    expect(lists).toHaveLength(1);
    for (const legacy of LEGACY_READ_RELAYS) expect(lists[0]).toContain(legacy);
    // The contact's own list is kept as well.
    for (const r of DEFAULT_RELAYS) expect(lists[0]).toContain(r);
  });

  it('counts as sent only when a non-legacy relay accepted it', async () => {
    const got = await a.client.identity.relayMigration();
    if (got.status !== 'needed') throw new Error('test: expected needed');
    await migrate(a, got.relays);
    acceptOnly = (relay) => LEGACY_READ_RELAYS.includes(relay);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 1 });
  });

  it('legacy OKs alone never end its row: it stays pending and retries until a current relay accepts', async () => {
    const got = await a.client.identity.relayMigration();
    if (got.status !== 'needed') throw new Error('test: expected needed');
    await migrate(a, got.relays);
    // Both legacy relays answer OK (that alone is MIN_ACKS); no relay of the contact's list does.
    acceptOnly = (relay) => LEGACY_READ_RELAYS.includes(relay);
    await a.client.sendCardUpdates();
    expect(await cardUpdateContactStates(a)).toEqual(['pending']);
    // The next attempt (within the usual backoff) still has only the legacy OKs: still pending.
    clock.t += 31;
    await a.client.outbox.processDue();
    expect(await cardUpdateContactStates(a)).toEqual(['pending']);
    // A relay of the contact's own list accepts it: now it is sent.
    acceptOnly = undefined;
    clock.t += 61;
    await a.client.outbox.processDue();
    expect(await cardUpdateContactStates(a)).toEqual(['sent']);
    // Nothing new is sent in the next pass: the contact holds the card now.
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 0, failed: 0 });
  });

  it('an ordinary message to a contact that lists a legacy relay is unchanged: its OKs count', async () => {
    // b's contact `a` still lists the legacy relays in its card: two legacy OKs end the row.
    acceptOnly = (relay) => LEGACY_READ_RELAYS.includes(relay);
    await b.client.sendMessage({ to: a.id, text: 'hi' });
    const states = await b.store.transaction((tx) =>
      tx.select('outbox', { role: 'contact' }).map((r) => r.state),
    );
    expect(states).toEqual(['sent']);
  });

  it('after LEGACY_CARD_UPDATE_UNTIL the card-update goes to the legacy relays no longer', async () => {
    expect(LEGACY_CARD_UPDATE_UNTIL).toBeGreaterThan(START);
    const got = await a.client.identity.relayMigration();
    if (got.status !== 'needed') throw new Error('test: expected needed');
    clock.t = LEGACY_CARD_UPDATE_UNTIL;
    await migrate(a, got.relays);
    expect(await a.client.sendCardUpdates()).toEqual({ sent: 1, failed: 0 });
    const lists = await cardUpdateContactRelays(a);
    expect(lists).toHaveLength(1);
    for (const legacy of LEGACY_READ_RELAYS) expect(lists[0]).not.toContain(legacy);
  });
});

describe('LEGACY_CARD_UPDATE_UNTIL', () => {
  it('ends the fan-out at least 30 days after this release (2026-11-18)', () => {
    const release = Date.UTC(2026, 10, 18) / 1000;
    expect(LEGACY_CARD_UPDATE_UNTIL - release).toBeGreaterThanOrEqual(30 * 86_400);
  });
});
