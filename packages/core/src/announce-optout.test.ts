// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 07 §4.3 "Privacy" and "Card-update fan-out"; 04 §2.5.1
// `network.announce`, §7): "Don't also announce on the default servers".
//
// - `network.announce` is an owner action (owner signature; no MCP path, I-4): prepared and applied
//   only for this agent; `false` is refused with `mix_in_on` while the agent's list holds a default
//   server (or one of the old default servers, the legacy set); a replay is refused.
// - With the opt-out on, nothing about this ID goes to the default or legacy servers: the owner
//   card-update goes to the own and leaving servers only, and the legacy card-update fan-out to
//   contacts stops. Contacts' card-updates, handshakes and messages still go to each contact's own
//   list, also when that list is the default set.
// - Turning it on without a rotation ends the retries there: pending card-update rows that still
//   name a default or legacy server outside the recipient's own list lose those servers, at once
//   and on every later sync pass (so a crash in between cannot leave them for 24 h).
// - Invites (long and short) carry the card's own list; the short-invite path falls back to the long
//   link with the same list, never to the default servers.
// - The whole cycle (invite, pairing, send, sync, card-update, owner announce) publishes nothing to
//   any default or legacy server; the same cycle without the opt-out does (the control).
import { decodeBase64url, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  DEFAULT_RELAYS,
  LEGACY_READ_RELAYS,
  wrapEnvelope,
  type PublishOutcome,
} from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import type { FilesPlatform } from './files/platform.js';
import { clearShortInviteCache, decodeInviteLink } from './invite-link.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { giftWrapId, pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const clock = new FakeClock();
const START = clock.t;
const DAY = 86_400;

const list = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);
const OWN = list('a', 3);
const OWN2 = list('n', 2);
const BL = list('b', 2);
/** Every server the opt-out keeps this ID off: the release's default set and the old one. */
const OFF_LIMITS: ReadonlySet<string> = new Set([...DEFAULT_RELAYS, ...LEGACY_READ_RELAYS]);
const offLimits = (relays: readonly string[]): string[] => relays.filter((r) => OFF_LIMITS.has(r));

/** While true, every relay refuses every publish (rows stay pending). */
let refuseAll = false;

interface Agent extends TestAgent {
  /** The relays of every publish, in order. */
  readonly published: string[][];
}

const ORIGIN = 'https://drop.test';

/** A drop that keeps invite objects (the short invite, 04 §3.6.2); `down` refuses every request. */
function fakeDrop() {
  const objects = new Map<string, Uint8Array>();
  const state = { down: false };
  const fetch = async (request: Request): Promise<Response> => {
    if (state.down) throw new Error('connect ECONNREFUSED');
    const url = new URL(request.url);
    const id = /^\/v1\/i\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
    if (request.method === 'POST' && url.pathname === '/v1/invite') {
      const parsed = JSON.parse(await request.text()) as {
        lookupId: string;
        object: string;
        expiresAt: number;
      };
      objects.set(parsed.lookupId, decodeBase64url(parsed.object));
      return new Response(JSON.stringify({ expiresAt: parsed.expiresAt }), { status: 201 });
    }
    if (request.method === 'GET' && id !== undefined) {
      const obj = objects.get(id);
      return obj === undefined
        ? new Response('{"error":"not_found"}', { status: 404 })
        : new Response(obj as Uint8Array<ArrayBuffer>, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
    }
    if (request.method === 'DELETE' && id !== undefined) {
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  };
  return { objects, state, fetch };
}
type Drop = ReturnType<typeof fakeDrop>;

function platform(drop: Drop): FilesPlatform {
  return {
    allowedFolderRealpaths: () => Promise.resolve([]),
    download: () => {
      throw new Error('unused');
    },
    inbox: () => Promise.reject(new Error('unused')),
    drop: { endpoint: ORIGIN, fetch: drop.fetch },
  };
}

async function agent(
  n: number,
  relays: readonly string[],
  drop?: Drop,
): Promise<Agent> {
  const owner = new MemoryOwnerKeyStore(seed(n + 100), passphrase());
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n), { nowSeconds: () => clock.now() });
  const published: string[][] = [];
  const factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (_event, to) => {
      published.push([...to]);
      return Promise.resolve(
        refuseAll
          ? ({
              results: to.map((relay) => ({ relay, ok: false, reason: 'connect_failed' as const })),
              acked: [],
              sent: false,
            } as PublishOutcome)
          : ({
              results: to.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
              acked: [...to],
              sent: to.length > 0,
            } as PublishOutcome),
      );
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
    subscribe: () => () => Promise.resolve(),
  });
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: factory,
    policyMark: new MemoryPolicyMark(),
    ...(drop === undefined ? {} : { files: platform(drop) }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: `agent${n}`,
    relays,
  });
  return {
    client,
    store,
    cipher,
    keyStore,
    owner: owner as unknown as TestOwner,
    id: client.agentId,
    published,
  };
}

/** Signs `body` with the agent's owner and applies it through core (what the app's gate does). */
async function signAndApply(x: Agent, body: unknown) {
  const session = await x.owner.unlock(passphrase());
  try {
    const plain = JSON.parse(JSON.stringify(body)) as Parameters<typeof session.signOwnerAction>[0];
    return await x.client.ownerActions.apply({ body: plain, sig: await session.signOwnerAction(plain) });
  } finally {
    await session.close();
  }
}

/** The owner's `network.announce` for `x`, prepared by core, signed and applied. */
async function announce(x: Agent, announceDefault: boolean) {
  const prepared = await x.client.ownerActions.prepareAnnounce(announceDefault);
  if (prepared.status !== 'prepared') return prepared;
  return signAndApply(x, prepared.body);
}

async function change(x: Agent, relays: readonly string[], announceDefault?: boolean) {
  await x.client.identity.rotate({
    owner: await x.owner.unlock(passphrase()),
    ownerKeys: await x.owner.getPublicKeys(),
    epochControl: x.owner.epochControl(x.keyStore),
    relays,
    ...(announceDefault === undefined ? {} : { announceDefault }),
  });
}

/** Every outbox row of `x` with its opened relays and its envelope's type and contact. */
async function outboxRows(x: Agent) {
  const rows = await x.store.transaction((tx) =>
    tx
      .select('outbox')
      .map((r) => ({ row: r, env: tx.get('envelopes', { envelope_id: r.envelope_id }) })),
  );
  const out: {
    type: string | undefined;
    contact: string | null | undefined;
    role: string;
    state: string;
    relays: string[];
  }[] = [];
  for (const { row, env } of rows) {
    const text = await x.cipher.open(
      { table: 'outbox', column: 'relays', rowKey: rowKeyOf([row.wrap_id]) },
      row.relays,
    );
    out.push({
      type: env?.type,
      contact: env?.contact_id,
      role: row.role,
      state: row.state,
      relays: JSON.parse(text) as string[],
    });
  }
  return out;
}

async function deliver(to: TestAgent, envelope: unknown) {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status !== 'verified') return [received.report];
  return to.client.envelopes.processReceived();
}

async function lastOut(from: TestAgent, type: string): Promise<unknown> {
  const rows = await from.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type }, { orderBy: [['created_at', 'desc']] }),
  );
  const row = rows[0];
  if (row?.envelope_json == null) throw new Error(`test: no ${type}`);
  return JSON.parse(row.envelope_json) as unknown;
}

let a: Agent;

beforeEach(async () => {
  clock.t = START;
  refuseAll = false;
  clearShortInviteCache();
  a = await agent(91, OWN);
});

describe('network.announce (04 §2.5.1): an owner action for this agent only', () => {
  it('turns the opt-out on and off without changing the list or the card', async () => {
    const before = await a.client.identity.get();
    expect(await a.client.identity.announceDefault()).toBe(true);
    expect(await announce(a, false)).toEqual({ status: 'applied', op: 'network.announce' });
    expect(await a.client.identity.announceDefault()).toBe(false);
    expect(await a.client.identity.relays()).toEqual(OWN);
    expect((await a.client.identity.get())?.keyEpoch).toBe(before?.keyEpoch);
    expect(await announce(a, true)).toEqual({ status: 'applied', op: 'network.announce' });
    expect(await a.client.identity.announceDefault()).toBe(true);
  });

  it('refuses the opt-out with mix_in_on while the list holds a default or an old default server', async () => {
    const d = await agent(92, DEFAULT_RELAYS.slice(0, 2));
    expect(await d.client.ownerActions.prepareAnnounce(false)).toMatchObject({
      status: 'refused',
      reason: 'mix_in_on',
    });
    // A signed body that skipped the prepare is refused by apply too.
    const on = await d.client.ownerActions.prepareAnnounce(true);
    if (on.status !== 'prepared') throw new Error('test: not prepared');
    const forged = {
      ...(on.body as unknown as Record<string, unknown>),
      params: { agent: d.id, announceDefault: false },
    };
    expect(await signAndApply(d, forged)).toMatchObject({ status: 'refused', reason: 'mix_in_on' });
    expect(await d.client.identity.announceDefault()).toBe(true);
    const legacy = await agent(93, [OWN[0] as string, LEGACY_READ_RELAYS[0] as string]);
    expect(await legacy.client.ownerActions.prepareAnnounce(false)).toMatchObject({
      status: 'refused',
      reason: 'mix_in_on',
    });
    // Turning it back on is always allowed.
    expect(await announce(d, true)).toEqual({ status: 'applied', op: 'network.announce' });
  });

  it('refuses a replay, another agent and a body that is not exactly its params', async () => {
    const prepared = await a.client.ownerActions.prepareAnnounce(false);
    if (prepared.status !== 'prepared') throw new Error('test: not prepared');
    expect(await signAndApply(a, prepared.body)).toMatchObject({ status: 'applied' });
    expect(await signAndApply(a, prepared.body)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
    const other = await agent(94, BL);
    const again = await a.client.ownerActions.prepareAnnounce(true);
    if (again.status !== 'prepared') throw new Error('test: not prepared');
    const body = again.body as unknown as Record<string, unknown>;
    expect(
      await signAndApply(a, { ...body, params: { agent: other.id, announceDefault: true } }),
    ).toMatchObject({ status: 'refused' });
    expect(
      await signAndApply(a, { ...body, params: { agent: a.id, announceDefault: true, x: 1 } }),
    ).toMatchObject({ status: 'refused', reason: 'malformed' });
    expect(await a.client.identity.announceDefault()).toBe(false);
  });

  it('a reset to the automatic servers or a change that mixes default servers back in clears it', async () => {
    await announce(a, false);
    // A list that holds a default server again (the mix-in back on), even without the choice.
    await change(a, [OWN[0] as string, ...DEFAULT_RELAYS.slice(0, 2)]);
    expect(await a.client.identity.announceDefault()).toBe(true);
    await announce(a, true);
    const b = await agent(90, OWN);
    await announce(b, false);
    await change(b, DEFAULT_RELAYS.slice(0, 3), true);
    expect(await b.client.identity.announceDefault()).toBe(true);
  });
});

describe('with the opt-out on, nothing about this ID goes to the default servers', () => {
  it('the owner card-update goes to the own and leaving servers only (07 §4.3)', async () => {
    await announce(a, false);
    await a.client.cardUpdates.announceToOwner();
    clock.t += DAY;
    await change(a, OWN2);
    await a.client.cardUpdates.announceToOwner();
    const owner = (await outboxRows(a)).filter((r) => r.type === 'card-update' && r.contact === null);
    expect(owner.length).toBeGreaterThan(0);
    for (const row of owner) {
      expect(offLimits(row.relays)).toEqual([]);
      for (const relay of row.relays) expect([...OWN, ...OWN2]).toContain(relay);
    }
    expect(a.published.flatMap(offLimits)).toEqual([]);
  });

  it('the legacy card-update fan-out to contacts stops; the contact still gets it on its own list', async () => {
    const b = await agent(95, BL);
    await pairWith(clock, a, b);
    await announce(a, false);
    clock.t += 60;
    await change(a, OWN2);
    await a.client.sendCardUpdates();
    const toContact = (await outboxRows(a)).filter(
      (r) => r.type === 'card-update' && r.contact !== null && r.role === 'contact',
    );
    expect(toContact.length).toBeGreaterThan(0);
    for (const row of toContact) expect(row.relays).toEqual(BL);
    expect(a.published.flatMap(offLimits)).toEqual([]);
  });

  it('control: without the opt-out the same card-update also goes to the legacy servers', async () => {
    const b = await agent(96, BL);
    await pairWith(clock, a, b);
    clock.t += 60;
    await change(a, OWN2);
    await a.client.sendCardUpdates();
    const toContact = (await outboxRows(a)).filter(
      (r) => r.type === 'card-update' && r.contact !== null && r.role === 'contact',
    );
    expect(toContact.some((r) => offLimits(r.relays).length > 0)).toBe(true);
    expect(a.published.flatMap(offLimits).length).toBeGreaterThan(0);
  });

  it("a contact whose own list is the default set still gets it there (each contact's own list)", async () => {
    const c = await agent(97, DEFAULT_RELAYS.slice(0, 2));
    await pairWith(clock, a, c);
    await announce(a, false);
    clock.t += 60;
    await change(a, OWN2);
    await a.client.sendCardUpdates();
    await a.client.sendMessage({ to: c.id, text: 'hello' });
    const rows = await outboxRows(a);
    const toC = rows.filter((r) => r.contact !== null && r.role === 'contact');
    expect(toC.length).toBeGreaterThan(0);
    for (const row of toC) expect(row.relays).toEqual(DEFAULT_RELAYS.slice(0, 2));
    // Its own copies (the own owner and agent) and the owner card-update stay off the default set.
    for (const row of rows.filter((r) => r.role === 'owner')) {
      expect(offLimits(row.relays)).toEqual([]);
    }
  });
});

describe('turned on without a rotation: pending retries to the default servers end (Fable note)', () => {
  it('pending owner and contact card-update rows lose the default and legacy servers at once', async () => {
    const b = await agent(98, BL);
    await pairWith(clock, a, b);
    refuseAll = true;
    clock.t += 60;
    await change(a, OWN2);
    await a.client.sendCardUpdates();
    const pending = (await outboxRows(a)).filter(
      (r) => r.type === 'card-update' && r.state === 'pending',
    );
    // Before: the owner card-update names the default set, the contact's the legacy servers.
    expect(pending.some((r) => r.contact === null && offLimits(r.relays).length > 0)).toBe(true);
    expect(pending.some((r) => r.contact !== null && offLimits(r.relays).length > 0)).toBe(true);
    expect(await announce(a, false)).toMatchObject({ status: 'applied' });
    await a.client.cardUpdates.withdrawFromDefaultServers();
    const after = (await outboxRows(a)).filter(
      (r) => r.type === 'card-update' && r.state === 'pending',
    );
    expect(after.length).toBe(pending.length);
    for (const row of after) {
      expect(offLimits(row.relays)).toEqual([]);
      if (row.role === 'contact') expect(row.relays).toEqual(BL);
      else for (const relay of row.relays) expect([...OWN, ...OWN2]).toContain(relay);
    }
    // The next attempts publish nowhere off limits.
    a.published.length = 0;
    refuseAll = false;
    clock.t += 3_600;
    await a.client.outbox.processDue();
    expect(a.published.length).toBeGreaterThan(0);
    expect(a.published.flatMap(offLimits)).toEqual([]);
  });

  it('a sync pass ends them too, so a crash between the opt-out and the clean-up leaves none', async () => {
    refuseAll = true;
    await a.client.cardUpdates.announceToOwner();
    const before = (await outboxRows(a)).filter((r) => r.state === 'pending');
    expect(before.some((r) => offLimits(r.relays).length > 0)).toBe(true);
    expect(await announce(a, false)).toMatchObject({ status: 'applied' });
    await a.client.syncInbox();
    for (const row of (await outboxRows(a)).filter((r) => r.state === 'pending')) {
      expect(offLimits(row.relays)).toEqual([]);
    }
  });
});

describe('invites carry the card list (07 §4.3: new contacts reach you unchanged)', () => {
  it('a long invite and the short-invite fallback name exactly the own list', async () => {
    const drop = fakeDrop();
    const x = await agent(99, OWN, drop);
    await announce(x, false);
    const long = await x.client.pairing.createInvite({ long: true });
    expect((await decodeInviteLink(long.inviteUrl)).relays).toEqual(OWN);
    drop.state.down = true;
    const fallback = await x.client.pairing.createInvite();
    expect(fallback.format).toBe('long');
    expect((await decodeInviteLink(fallback.inviteUrl)).relays).toEqual(OWN);
  });
});

describe('the whole cycle: zero publishes to any default or legacy server', () => {
  async function cycle(optOut: boolean): Promise<{ readonly x: Agent; readonly y: Agent }> {
    const drop = fakeDrop();
    const x = await agent(optOut ? 101 : 103, OWN, drop);
    const y = await agent(optOut ? 102 : 104, BL, drop);
    if (optOut) expect(await announce(x, false)).toMatchObject({ status: 'applied' });
    // Invite (short, on the drop), accept, handshake and ack.
    const invite = await x.client.pairing.createInvite();
    expect(invite.format).toBe('short');
    const accepted = await y.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    // The handshake goes to the inviter's own list, never a default server.
    const toInviter = (await outboxRows(y)).filter((r) => r.type === 'handshake');
    for (const row of toInviter.filter((r) => r.role === 'contact')) {
      expect(row.relays).toEqual(OWN);
    }
    await deliver(x, accepted.handshake.envelope);
    await x.client.outbox.processDue();
    await deliver(y, await lastOut(x, 'handshake-ack'));
    // Send, sync, a list change (card-update to the contact), the owner announce, a week later.
    await x.client.sendMessage({ to: (await x.client.contacts.list())[0]?.id ?? '', text: 'hi' });
    await x.client.syncInbox();
    clock.t += 60;
    await change(x, OWN2);
    await x.client.sendCardUpdates();
    await x.client.syncInbox();
    clock.t += 8 * DAY;
    await x.client.syncInbox();
    await x.client.outbox.processDue();
    return { x, y };
  }

  it('with the opt-out on', async () => {
    const { x } = await cycle(true);
    expect(x.published.length).toBeGreaterThan(4);
    expect(x.published.flatMap(offLimits)).toEqual([]);
    for (const row of await outboxRows(x)) expect(offLimits(row.relays)).toEqual([]);
  });

  it('control: the same cycle without it reaches the default and the legacy servers', async () => {
    const { x } = await cycle(false);
    const hit = x.published.flatMap(offLimits);
    expect(hit.some((r) => DEFAULT_RELAYS.includes(r))).toBe(true);
    expect(hit.some((r) => LEGACY_READ_RELAYS.includes(r) && !DEFAULT_RELAYS.includes(r))).toBe(
      true,
    );
  });
});
