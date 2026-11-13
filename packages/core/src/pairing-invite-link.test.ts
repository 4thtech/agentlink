// REL051-B2 (owner test, 13 Nov; 04 §3.6, 07 §3, 08 §1): the owner can copy an open invite's link
// again. The inviter keeps the link it handed out (short, long or the long fallback) sealed in
// `invites.invite_link`, answers it only for an open invite (not used, not cancelled, not expired),
// and clears it when the invite is used or cancelled. An invite stored before the column existed
// answers `no_link`. The link is never logged.
import { decodeBase64url, encodeBase64url } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import type { FilesPlatform } from './files/platform.js';
import { clearShortInviteCache } from './invite-link.js';
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
const clock = new FakeClock();

/** A drop that keeps invite objects; `down` makes every request fail (the long fallback). */
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
        : new Response(obj as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    if (request.method === 'DELETE' && id !== undefined) {
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  };
  return { objects, state, fetch };
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

const rowOf = async (a: { store: MemoryStore }, inviteId: string) =>
  (await a.store.transaction((tx) => tx.select('invites'))).find((r) => r.invite_id === inviteId);

beforeEach(() => clearShortInviteCache());

describe('copy an open invite link again (REL051-B2)', () => {
  it('answers the same short link create answered, with its format and expiry', async () => {
    const drop = fakeDrop();
    const a = await agent(61, 'Ana', drop);
    const created = await a.client.pairing.createInvite({ label: 'Bo' });
    expect(created.format).toBe('short');
    expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({
      status: 'ok',
      inviteUrl: created.inviteUrl,
      format: 'short',
      expiresAt: created.expiresAt,
    });
  });

  it('answers a long link (asked for, or the fallback when the drop is down)', async () => {
    const drop = fakeDrop();
    const a = await agent(62, 'Ana', drop);
    const long = await a.client.pairing.createInvite({ long: true });
    drop.state.down = true;
    const fallback = await a.client.pairing.createInvite();
    expect(fallback.format).toBe('long');
    for (const created of [long, fallback]) {
      expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({
        status: 'ok',
        inviteUrl: created.inviteUrl,
        format: 'long',
        expiresAt: created.expiresAt,
      });
    }
  });

  it('keeps the link sealed at rest, never in plain text, and never logs it', async () => {
    const drop = fakeDrop();
    const a = await agent(63, 'Ana', drop);
    const created = await a.client.pairing.createInvite();
    await a.client.pairing.inviteLink(created.inviteId);
    const row = await rowOf(a, created.inviteId);
    expect(typeof row?.invite_link).toBe('string');
    expect(row?.invite_link).not.toBe(created.inviteUrl);
    expect(JSON.stringify(row)).not.toContain(created.inviteUrl.slice(-43));
    // Sealed by the store cipher in its own context (table, column, row), like proof_key.
    const opened = await new TestStoreCipher().open(
      { table: 'invites', column: 'invite_link', rowKey: JSON.stringify([created.inviteId]) },
      row!.invite_link!,
    );
    expect(opened).toBe(created.inviteUrl);
    expect(a.lines.join('\n')).not.toContain(created.inviteUrl.slice(-43));
  });

  it('a cancelled invite answers not_found and its stored link is cleared', async () => {
    const a = await agent(64, 'Ana', undefined);
    const created = await a.client.pairing.createInvite();
    expect(await a.client.pairing.cancelInvite(created.inviteId)).toBe('cancelled');
    expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({ status: 'not_found' });
    expect((await rowOf(a, created.inviteId))?.invite_link).toBeNull();
  });

  it('an accepted invite answers not_found and its stored link is cleared', async () => {
    const a = await agent(65, 'Ana', undefined);
    const b = await agent(66, 'Bo', undefined);
    const created = await a.client.pairing.createInvite();
    const started = await b.client.pairing.acceptInvite({ link: created.inviteUrl, allowed: true });
    if (started.status !== 'pending') throw new Error('test: not started');
    await a.client.envelopes.receive({
      envelope: started.handshake.envelope,
      giftWrapId: giftWrapId(),
    });
    await a.client.envelopes.processReceived();
    const row = await rowOf(a, created.inviteId);
    expect(row?.used_at).not.toBeNull();
    expect(row?.invite_link).toBeNull();
    expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({ status: 'not_found' });
  });

  it('an expired invite answers not_found', async () => {
    const a = await agent(67, 'Ana', undefined);
    const created = await a.client.pairing.createInvite({ expiresInDays: 1 });
    clock.t += 2 * 86_400;
    try {
      expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({ status: 'not_found' });
    } finally {
      clock.t -= 2 * 86_400;
    }
  });

  it("the sweep clears an expired invite's kept link, with or without a drop (IR-REL051-B2-1)", async () => {
    for (const [n, drop] of [
      [70, undefined],
      [71, fakeDrop()],
    ] as const) {
      const a = await agent(n, 'Ana', drop);
      const old = await a.client.pairing.createInvite({ expiresInDays: 1 });
      const open = await a.client.pairing.createInvite();
      clock.t += 2 * 86_400;
      try {
        await a.client.pairing.sweepInviteObjects();
      } finally {
        clock.t -= 2 * 86_400;
      }
      expect((await rowOf(a, old.inviteId))?.invite_link).toBeNull();
      expect((await rowOf(a, open.inviteId))?.invite_link).not.toBeNull();
    }
  });

  it('an invite stored before links were kept answers no_link; unknown or malformed ids not_found', async () => {
    const a = await agent(68, 'Ana', undefined);
    const created = await a.client.pairing.createInvite();
    await a.store.transaction((tx) => {
      tx.update('invites', { invite_id: created.inviteId }, { invite_link: null });
    });
    expect(await a.client.pairing.inviteLink(created.inviteId)).toEqual({ status: 'no_link' });
    expect(await a.client.pairing.inviteLink('nope')).toEqual({ status: 'not_found' });
    expect(await a.client.pairing.inviteLink(encodeBase64url(new Uint8Array(16)))).toEqual({
      status: 'not_found',
    });
  });

  it('the open list still names no link', async () => {
    const a = await agent(69, 'Ana', undefined);
    const created = await a.client.pairing.createInvite({ label: 'Bo' });
    const list = await a.client.pairing.openInvites();
    expect(JSON.stringify(list)).not.toContain(created.inviteUrl.slice(-40));
  });
});
