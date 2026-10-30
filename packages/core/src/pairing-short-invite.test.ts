// W4-SHORT-INVITE and W4-INVITES-LIST (04 §3.6.2, D-139; 07 §3, §5.4; 08 §1). The inviter's side of
// short links: by default the invite is sealed as an `ALI1` object and uploaded to the drop, and the
// link is `…/i#2.<43>`; the lookup ID and the drop key epoch are recorded (sealed) BEFORE the upload
// is sent; a drop failure falls back to the format 1 link for the same invite and still deletes the
// recorded object; `long: true` uploads nothing. Cancel, completion and expiry delete the object with
// the recorded epoch. The open-invites list names the label and expiry only, never a link. Neither
// the link secret nor the lookup ID is ever logged, and K is never stored.
import {
  decodeBase64url,
  encodeBase64url,
  parseJson,
  shortInviteLookupId,
  type Envelope,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLinkClient } from './client.js';
import type { FilesPlatform } from './files/platform.js';
import { INVITE_LINK_PREFIX, clearShortInviteCache } from './invite-link.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { giftWrapId } from './testing/envelopes.js';

const ORIGIN = 'https://drop.test';
const SHORT = /^https:\/\/agentlink\.4thtech\.io\/i#2\.([A-Za-z0-9_-]{43})$/;
const clock = new FakeClock();

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly at: 'before' | 'after';
}

/** A minimal drop: stores invite objects by lookup ID; `mode` makes every request fail one way. */
function fakeDrop() {
  const objects = new Map<string, Uint8Array>();
  const seen: Seen[] = [];
  const state = {
    mode: 'ok' as 'ok' | 'down' | 'busy' | 'refuse' | 'hang',
    onUpload: async (): Promise<void> => {},
  };
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.text();
    seen.push({ method: request.method, path: url.pathname, body, at: 'before' });
    if (state.mode === 'down') throw new Error('connect ECONNREFUSED');
    // A drop that accepts the connection and never answers (no abort honoured either).
    if (state.mode === 'hang') return new Promise<Response>(() => {});
    if (state.mode === 'busy') return new Response('{}', { status: 503 });
    const id = /^\/v1\/i\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
    if (request.method === 'POST' && url.pathname === '/v1/invite') {
      await state.onUpload();
      if (state.mode === 'refuse') return new Response('{"error":"limit"}', { status: 429 });
      const parsed = JSON.parse(body) as { lookupId: string; object: string; expiresAt: number };
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
      if (state.mode === 'refuse') return new Response('{}', { status: 503 });
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  };
  return { objects, seen, state, fetch };
}

function platform(drop: ReturnType<typeof fakeDrop>): FilesPlatform {
  return {
    allowedFolderRealpaths: () => Promise.resolve([]),
    download: () => {
      throw new Error('unused');
    },
    inbox: () => Promise.reject(new Error('unused')),
    drop: { endpoint: ORIGIN, fetch: drop.fetch },
  };
}

async function agent(n: number, name: string, drop: ReturnType<typeof fakeDrop> | undefined) {
  const lines: string[] = [];
  const store = new MemoryStore();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(n)),
    store,
    cipher: new TestStoreCipher(),
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
    ...(drop === undefined ? {} : { files: platform(drop) }),
  });
  const owner = new MemoryOwnerKeyStore(seed(n + 100), passphrase());
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return { client, store, lines };
}

const inviteRows = (a: { store: MemoryStore }) => a.store.transaction((tx) => tx.select('invites'));

beforeEach(() => clearShortInviteCache());
afterEach(() => vi.useRealTimers());

describe('create: short by default (04 §3.6.2 Create)', () => {
  it('uploads the ALI1 object under the derived lookup ID and returns `…/i#2.<43>`', async () => {
    const drop = fakeDrop();
    const a = await agent(31, 'Ana', drop);
    const created = await a.client.pairing.createInvite({ label: 'Bo' });
    const m = SHORT.exec(created.inviteUrl);
    expect(m).not.toBeNull();
    expect(created.inviteUrl.length).toBeLessThanOrEqual(80);
    expect(created.format).toBe('short');
    const lookupId = encodeBase64url(shortInviteLookupId(decodeBase64url(m![1]!)));
    expect([...drop.objects.keys()]).toEqual([lookupId]);
    const upload = drop.seen.find((s) => s.path === '/v1/invite');
    const body = JSON.parse(upload!.body) as Record<string, unknown>;
    // The drop object's expiry equals the invite's (the only bound the Worker can enforce).
    expect(body['expiresAt']).toBe(created.expiresAt);
    // Zero access: the drop never sees the link secret in any request (I-1).
    expect(JSON.stringify(drop.seen)).not.toContain(m![1]!);
  });

  it('records the lookup ID and drop key epoch, sealed, BEFORE the upload is sent', async () => {
    const drop = fakeDrop();
    const a = await agent(32, 'Ana', drop);
    // The drop reads the store while it handles the upload: the row is already committed, with
    // the lookup ID and epoch recorded.
    const atUpload: { lookup: unknown; epoch: unknown }[] = [];
    drop.state.onUpload = async () => {
      for (const r of await inviteRows(a)) {
        atUpload.push({ lookup: r.drop_lookup_id, epoch: r.drop_key_epoch });
      }
    };
    const created = await a.client.pairing.createInvite();
    expect(atUpload).toHaveLength(1);
    expect(atUpload[0]?.lookup).not.toBeNull();
    expect(atUpload[0]?.epoch).not.toBeNull();
    const rows = await inviteRows(a);
    const row = rows[0]!;
    expect(row.drop_lookup_id).not.toBeNull();
    expect(row.drop_key_epoch).not.toBeNull();
    // Sealed at rest: neither column holds the clear lookup ID or epoch.
    const lookupId = encodeBase64url(
      shortInviteLookupId(decodeBase64url(SHORT.exec(created.inviteUrl)![1]!)),
    );
    expect(JSON.stringify(row)).not.toContain(lookupId);
    // K and the invite key are never stored anywhere.
    const secret = SHORT.exec(created.inviteUrl)![1]!;
    expect(JSON.stringify(await a.store.transaction((tx) => tx.select('invites')))).not.toContain(
      secret,
    );
  });

  it('falls back to the format 1 link when the drop is down, busy or refuses, and deletes the object', async () => {
    for (const mode of ['down', 'busy', 'refuse'] as const) {
      const drop = fakeDrop();
      drop.state.mode = mode;
      const a = await agent(33, 'Ana', drop);
      const created = await a.client.pairing.createInvite();
      expect(created.format).toBe('long');
      expect(created.inviteUrl.startsWith(INVITE_LINK_PREFIX)).toBe(true);
      expect(created.inviteUrl).not.toMatch(SHORT);
      // A DELETE for the recorded lookup ID was attempted (the upload outcome may be ambiguous);
      // it runs in the background (O-L1), so this waits for the sweep in flight.
      await a.client.pairing.sweepInviteObjects();
      expect(drop.seen.some((s) => s.method === 'DELETE' && s.path.startsWith('/v1/i/'))).toBe(
        true,
      );
    }
  });

  it('a drop that never answers: the format 1 link within the 10 s upload deadline (O-L1)', async () => {
    const drop = fakeDrop();
    const a = await agent(37, 'Ana', drop);
    drop.state.mode = 'hang';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const pending = a.client.pairing.createInvite().finally(() => {
        settled = true;
      });
      // The upload is sent (after real crypto work), then the drop goes silent.
      while (!drop.seen.some((s) => s.path === '/v1/invite')) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(9_000);
      expect(settled).toBe(false);
      // Long before safe-fetch's 60 s, and without waiting for the (also hung) object DELETE.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(true);
      const created = await pending;
      expect(created.format).toBe('long');
      expect(created.inviteUrl.startsWith(INVITE_LINK_PREFIX)).toBe(true);
      // The sweep was still started for the recorded object (the outcome is ambiguous).
      while (!drop.seen.some((s) => s.method === 'DELETE')) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('`long: true` uploads nothing and records no drop object', async () => {
    const drop = fakeDrop();
    const a = await agent(34, 'Ana', drop);
    const created = await a.client.pairing.createInvite({ long: true });
    expect(created.format).toBe('long');
    expect(created.inviteUrl).not.toMatch(SHORT);
    expect(drop.seen).toHaveLength(0);
    expect((await inviteRows(a))[0]?.drop_lookup_id).toBeNull();
  });

  it('with no drop configured the link is format 1', async () => {
    const a = await agent(35, 'Ana', undefined);
    const created = await a.client.pairing.createInvite();
    expect(created.format).toBe('long');
    expect(created.inviteUrl).not.toMatch(SHORT);
  });

  it('logs neither the link, the secret nor the lookup ID (I-7)', async () => {
    const drop = fakeDrop();
    const a = await agent(36, 'Ana', drop);
    const created = await a.client.pairing.createInvite();
    const secret = SHORT.exec(created.inviteUrl)![1]!;
    const lookupId = encodeBase64url(shortInviteLookupId(decodeBase64url(secret)));
    await a.client.pairing.cancelInvite((await a.client.pairing.openInvites())[0]!.inviteId);
    const log = a.lines.join('\n');
    expect(log).not.toContain(secret);
    expect(log).not.toContain(lookupId);
    expect(log).not.toContain(created.inviteUrl);
  });
});

describe('accept a short link (B)', () => {
  it('B resolves the link once through its drop and pairs; A deletes the object on completion', async () => {
    const drop = fakeDrop();
    const a = await agent(41, 'Ana', drop);
    const b = await agent(42, 'Bo', drop);
    const created = await a.client.pairing.createInvite();
    const pending = await b.client.pairing.acceptInvite({ link: created.inviteUrl });
    expect(pending.status).toBe('pending_approval');
    const started = await b.client.pairing.acceptInvite({ link: created.inviteUrl, allowed: true });
    expect(started.status).toBe('pending');
    // One fetch for the two accept calls (the resolved invite is reused in this process).
    expect(drop.seen.filter((s) => s.method === 'GET')).toHaveLength(1);
    if (started.status !== 'pending') return;
    // F-L1: a successful accept forgets the resolved link (it carries the pairing secret).
    await b.client.pairing.resolveInviteLink(created.inviteUrl);
    expect(drop.seen.filter((s) => s.method === 'GET')).toHaveLength(2);
    const received = await a.client.envelopes.receive({
      envelope: started.handshake.envelope,
      giftWrapId: giftWrapId(),
    });
    expect(received.status).toBe('verified');
    await a.client.envelopes.processReceived();
    await a.client.pairing.sweepInviteObjects();
    expect(drop.objects.size).toBe(0);
    expect((await inviteRows(a))[0]?.drop_lookup_id).toBeNull();
  });

  it('a cancelled short invite is no longer available, and its late answer is refused', async () => {
    const drop = fakeDrop();
    const a = await agent(43, 'Ana', drop);
    const b = await agent(44, 'Bo', drop);
    const created = await a.client.pairing.createInvite();
    const [open] = await a.client.pairing.openInvites();
    expect(await a.client.pairing.cancelInvite(open!.inviteId)).toBe('cancelled');
    expect(drop.objects.size).toBe(0);
    expect(await a.client.pairing.openInvites()).toEqual([]);
    const err = await b.client.pairing
      .acceptInvite({ link: created.inviteUrl })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('invite_unavailable');
    expect(await a.client.pairing.cancelInvite(open!.inviteId)).toBe('not_found');
  });

  it('a cancelled long invite refuses a late handshake', async () => {
    const a = await agent(45, 'Ana', undefined);
    const b = await agent(46, 'Bo', undefined);
    const created = await a.client.pairing.createInvite();
    const started = await b.client.pairing.acceptInvite({ link: created.inviteUrl, allowed: true });
    const [open] = await a.client.pairing.openInvites();
    await a.client.pairing.cancelInvite(open!.inviteId);
    if (started.status !== 'pending') throw new Error('test: not started');
    await a.client.envelopes.receive({
      envelope: started.handshake.envelope,
      giftWrapId: giftWrapId(),
    });
    const reports = await a.client.envelopes.processReceived();
    expect(JSON.stringify(reports)).toContain('invite_expired');
    expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(0);
    void parseJson;
    void ({} as Envelope);
  });
});

describe('a Cancel racing the answer (O-L2)', () => {
  it('a Cancel after the answer is checked, before it commits, still refuses the pairing', async () => {
    const drop = fakeDrop();
    const a = await agent(47, 'Ana', drop);
    const b = await agent(48, 'Bo', drop);
    const created = await a.client.pairing.createInvite();
    const started = await b.client.pairing.acceptInvite({ link: created.inviteUrl, allowed: true });
    if (started.status !== 'pending') throw new Error('test: not started');
    const [open] = await a.client.pairing.openInvites();
    await a.client.envelopes.receive({
      envelope: started.handshake.envelope,
      giftWrapId: giftWrapId(),
    });
    // The owner presses Cancel while A is between the answer's checks and its commit: the first
    // read of A's own card comes right after the cancelled/expired checks (pairing.ts).
    const identity = a.client.identity;
    const signedCard = identity.signedCard.bind(identity);
    let cancelled: string | undefined;
    identity.signedCard = async () => {
      if (cancelled === undefined) cancelled = await a.client.pairing.cancelInvite(open!.inviteId);
      return signedCard();
    };
    const reports = await a.client.envelopes.processReceived();
    expect(cancelled).toBe('cancelled');
    expect(JSON.stringify(reports)).toContain('invite_expired');
    expect(await a.store.transaction((tx) => tx.count('contacts'))).toBe(0);
    expect((await inviteRows(a))[0]?.used_at).toBeNull();
  });
});

describe('open invites (W4-INVITES-LIST)', () => {
  it('lists open invites with label and expiry only; used, cancelled and expired leave', async () => {
    const drop = fakeDrop();
    const a = await agent(51, 'Ana', drop);
    const one = await a.client.pairing.createInvite({ label: 'Bo' });
    await a.client.pairing.createInvite({ expiresInDays: 1 });
    const list = await a.client.pairing.openInvites();
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['expiresAt', 'inviteId', 'label']);
      expect(JSON.stringify(item)).not.toContain('#');
    }
    expect(list.find((i) => i.label === 'Bo')?.expiresAt).toBe(one.expiresAt);
    clock.t += 2 * 86_400;
    expect(await a.client.pairing.openInvites()).toHaveLength(1);
    // Expired invites' objects are deleted by the sweep.
    await a.client.pairing.sweepInviteObjects();
    expect(drop.objects.size).toBe(1);
    clock.t -= 2 * 86_400;
  });

  it('cancel refuses an unknown or malformed id', async () => {
    const a = await agent(52, 'Ana', undefined);
    expect(await a.client.pairing.cancelInvite('nope')).toBe('not_found');
    expect(await a.client.pairing.cancelInvite(encodeBase64url(new Uint8Array(16)))).toBe(
      'not_found',
    );
  });
});
