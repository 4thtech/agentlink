// U3-invite acceptance (S2): the waiting invite of the app host behind the approval server's gates
// (08 §4 "One step from an invite link"; 04 §3.6, §3.6.1; b11 §33.2; I-2, I-4, I-5, I-7).
//
// - The handoff (`POST /api/ui/join/handoff`, the handoff kind) runs before the session gate: only
//   the host's 32-byte token, no Origin, no Sec-Fetch-*, no cookie, no CSRF value, no query, an
//   octet-stream body `{"invite": "<link>"}`, at most one per 5 s; it stores the invite after Accept
//   step 1, signs nothing and opens the join screen (at most one open per 30 s). `invite_waiting`
//   while an invite is shown; replaced after "Not now" or expiry.
// - `GET /api/ui/join` answers only the state, the public inviteId, name, label, fingerprint and the
//   expiry; never the link.
// - `POST /api/ui/join/accept {inviteId}` is an owner route: a mismatch is `invite_changed` before
//   the presence gate (no owner store) and nothing is signed; with the owner code one
//   `approval.decide` is signed by the owner key, applied and used once; then the link is dropped.
// - `POST /api/ui/join/dismiss` ("Not now") is the invite kind: no presence, nothing signed.
// - The link (the invite secret) is in no event, opener URL, answer or record.
import {
  CoreError,
  INVITE_LINK_PREFIX,
  encodeInviteLink,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  canonicalizeToBytes,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { AgentDirectory, AppHostAgent, AppHostHandoffRecordValue } from './app-host.js';
import type { LocalUiAssets } from './context.js';
import {
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PATH,
} from './invite-paths.js';
import type { JoinCheck } from './join-desk.js';

const hex = (n: number, pair: string): string => pair.repeat(n);
const INVITE_ID = encodeBase64url(new Uint8Array(16).fill(1));
const OTHER_ID = encodeBase64url(new Uint8Array(16).fill(7));
const CONTACT_ID = `0x${hex(20, '1a')}`;
const EXPIRES_AT = 1_800_000_000;

/** A schema-valid invite (04 §3.6); signatures are shape-only (the checker seam stands in). */
const inviteObject = (inviteId = INVITE_ID) => ({
  v: 1,
  inviteId,
  secret: encodeBase64url(new Uint8Array(32).fill(2)),
  card: {
    version: 1,
    agentEvm: CONTACT_ID,
    agentNostr: `0x${hex(32, 'd4')}`,
    agentEnc: `0x${hex(32, '0e')}`,
    ownerEvm: `0x${hex(20, '2b')}`,
    ownerNostr: `0x${hex(32, 'c3')}`,
    ownerEnc: `0x${hex(32, '0f')}`,
    nameHash: `0x${hex(32, '11')}`,
    relaysHash: `0x${hex(32, '22')}`,
    issuedAt: 1760000000,
    expiresAt: 0,
    keyEpoch: 0,
  },
  cardSig: `0x${hex(64, '3c')}1b`,
  cardAgentSig: `0x${hex(64, '4d')}1c`,
  codeCommit: encodeBase64url(new Uint8Array(32).fill(3)),
  name: 'Marko',
  relays: ['wss://relay.example.org', 'wss://nos.example.net:7447/sub/path'],
  expiresAt: EXPIRES_AT,
});

let world: OwnerWorld;
let LINK = '';
let PAYLOAD = '';
let OTHER_LINK = '';

beforeAll(async () => {
  world = await ownerWorld('agentlink-u3-invite-');
  LINK = await encodeInviteLink(inviteObject() as never);
  PAYLOAD = LINK.slice(INVITE_LINK_PREFIX.length);
  OTHER_LINK = await encodeInviteLink(inviteObject(OTHER_ID) as never);
}, 60_000);

afterAll(() => world.cleanup());

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';
const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([['index.html', encodeUtf8(INDEX_HTML)]]),
});

const CONTACT = {
  id: CONTACT_ID,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' },
  ownerFingerprint: { short: '7F3A·19C2', long: '7F3A19C2'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};
const APPROVAL = `apr_${'Q'.repeat(22)}`;

/** Accept step 1 as core answers it for these links (signature checks stand in; tested in core). */
const check: JoinCheck = (link, nowSeconds) => {
  const id = link === OTHER_LINK ? OTHER_ID : link === LINK ? INVITE_ID : undefined;
  if (id === undefined) return Promise.reject(new CoreError('invite_invalid', 'x'));
  if (EXPIRES_AT <= nowSeconds) return Promise.reject(new CoreError('invite_expired', 'x'));
  return Promise.resolve({ inviteId: id, contact: CONTACT as never, expiresAt: EXPIRES_AT });
};

interface Core {
  accepted: { link: string; allowed: boolean }[];
  requested: unknown[];
  applied: { body: JsonObject; sig: string }[];
  ownerStores: number;
  contacts: { id: string; status: string }[];
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Options {
  readonly waitingInvite?: string;
  readonly agentId?: string;
  readonly realCheck?: boolean;
  readonly host?: boolean;
}

async function harness(opts: Options = {}) {
  const core: Core = { accepted: [], requested: [], applied: [], ownerStores: 0, contacts: [] };
  let stored: ApprovalForDecision | undefined;
  const client = {
    agentId: opts.agentId ?? world.agentId,
    pairing: {
      acceptInvite: ({ link, allowed }: { link: string; allowed?: boolean }) => {
        core.accepted.push({ link, allowed: allowed === true });
        return Promise.resolve(
          allowed === true
            ? { status: 'pending', contact: CONTACT, pairingId: 'p1', handshake: {} }
            : { status: 'pending_approval', contact: CONTACT },
        );
      },
    },
    contacts: { list: () => Promise.resolve(core.contacts) },
    ownerActions: {
      loadPolicy: () => Promise.resolve({ mode: 'fail_closed', problem: 'missing' }),
      loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
    },
    approvalService: {
      findOpen: () => Promise.resolve(undefined),
      request: (input: { action: JsonValue; summary: string }) => {
        core.requested.push(input);
        const digest = encodeHex(sha256(canonicalizeToBytes(input.action)));
        const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
        stored = {
          approvalId: APPROVAL,
          summary: input.summary,
          actionDigest: digest,
          storedDigest: digest,
          action: input.action,
          expiresAt,
          commitment: false,
        };
        return Promise.resolve({
          status: 'pending_approval',
          approvalId: APPROVAL,
          actionDigest: digest,
          summary: input.summary,
          expiresAt,
        });
      },
      use: () => Promise.resolve({ status: core.applied.length === 1 ? 'used' : 'void' }),
    },
    outbox: { processDue: () => Promise.resolve({ sent: 1, failed: 0, notDelivered: 0 }) },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: (id) => Promise.resolve(stored?.approvalId === id ? stored : undefined),
    apply: (signed) => {
      if (!ownerSigValid(world.owner, signed.body, signed.sig)) {
        return Promise.resolve({ status: 'refused', op: 'x', reason: 'sig' } as never);
      }
      core.applied.push(signed);
      return Promise.resolve({ status: 'applied', op: 'approval.decide' } as OwnerActionOutcome);
    },
  };
  const agent: AppHostAgent = {
    name: 'default',
    label: 'Personal',
    source,
    localUi: { client: client as never },
    close: () => Promise.resolve(),
  };
  const directory: AgentDirectory = {
    list: () =>
      Promise.resolve([{ name: 'default', label: 'Personal', available: true, removing: false }]),
    read: () =>
      Promise.resolve({ name: 'default', label: 'Personal', available: true, removing: false }),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: () => Promise.resolve(),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const records: AppHostHandoffRecordValue[] = [];
  let removed = 0;
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  let clock = 1_790_000_000_000;
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (e) => events.push(e),
      localUi: { assets: bundle(), client: client as never },
      ...(opts.host === false
        ? {}
        : {
            host: {
              directory,
              initial: agent,
              open: () => Promise.resolve(agent),
              handoff: {
                write: (record) => {
                  records.push(record);
                  return Promise.resolve();
                },
                remove: () => {
                  removed += 1;
                  return Promise.resolve();
                },
              },
              ...(opts.waitingInvite === undefined ? {} : { waitingInvite: opts.waitingInvite }),
            },
          }),
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => {
        core.ownerStores += 1;
        return KeychainOwnerKeyStore.open(world.keychain, expected);
      },
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      now: () => clock,
      ...(opts.realCheck === true ? {} : { checkInvite: check }),
    },
  );
  servers.push(server);
  const port = server.port;
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  opened.length = 0;
  const pageHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  });
  return {
    core,
    events,
    opened,
    records,
    removed: () => removed,
    server,
    port,
    advance: (ms: number) => {
      clock += ms;
    },
    /** `agentlink join`'s one request: exactly these headers unless changed. */
    handoff: (
      body: unknown,
      extra: Record<string, string> = {},
      omit: readonly string[] = [],
      path: string = JOIN_HANDOFF_PATH,
    ) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Handoff': records[0]?.handoffToken ?? '',
        ...extra,
      };
      for (const name of omit) Reflect.deleteProperty(headers, name);
      return send(port, path, {
        method: 'POST',
        headers,
        body: encodeUtf8(typeof body === 'string' ? body : JSON.stringify(body)),
      });
    },
    read: () => send(port, JOIN_PATH, { headers: pageHeaders() }),
    dismiss: (extra: Record<string, string> = {}) =>
      send(port, JOIN_DISMISS_PATH, {
        method: 'POST',
        headers: pageHeaders({
          'Content-Type': 'application/octet-stream',
          'X-AgentLink-Generation': '1',
          ...extra,
        }),
        body: encodeUtf8('{}'),
      }),
    accept: (inviteId: string, presence: string | undefined, extra: Record<string, string> = {}) =>
      send(port, JOIN_ACCEPT_PATH, {
        method: 'POST',
        headers: pageHeaders({
          'Content-Type': 'application/octet-stream',
          'X-AgentLink-Generation': '1',
          'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify({ inviteId }))),
          ...extra,
        }),
        ...(presence === undefined ? {} : { body: encodeUtf8(presence) }),
      }),
  };
}

const parse = (body: string): unknown => JSON.parse(body);

/** Nothing anywhere carries the invite (its payload holds the secret). */
function expectNoLink(h: Awaited<ReturnType<typeof harness>>, ...bodies: string[]): void {
  const needle = PAYLOAD.slice(0, 40);
  expect(JSON.stringify(h.events)).not.toContain(needle);
  expect(h.opened.join(' ')).not.toContain(needle);
  expect(JSON.stringify(h.records)).not.toContain(needle);
  for (const body of bodies) expect(body).not.toContain(needle);
}

describe('the handoff record (08 §4)', () => {
  it('is written once the host listens: pid, port and a fresh 32-byte token; removed on close', async () => {
    const h = await harness();
    expect(h.records).toHaveLength(1);
    const [record] = h.records;
    expect(record?.pid).toBe(process.pid);
    expect(record?.port).toBe(h.port);
    expect(record?.handoffToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await h.server.close();
    servers.splice(servers.indexOf(h.server), 1);
    expect(h.removed()).toBe(1);
  });

  it('a server that is not the app host takes no handoff and writes no record', async () => {
    const h = await harness({ host: false });
    expect(h.records).toHaveLength(0);
    const res = await h.handoff({ invite: LINK }, { 'X-AgentLink-Handoff': 'A'.repeat(43) });
    expect(res.status).toBe(501);
  });
});

describe('the handoff gate (08 §4)', () => {
  it('stores the invite after Accept step 1, signs nothing and opens the join screen', async () => {
    const h = await harness();
    const res = await h.handoff({ invite: LINK });
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({ status: 'waiting', opened: true });
    expect(h.opened).toHaveLength(1);
    expect(new URL(h.opened[0] ?? '').pathname).toBe('/settings/join');
    expect(h.core.ownerStores).toBe(0);
    expect(h.core.applied).toHaveLength(0);
    expect(h.core.accepted).toHaveLength(0);
    const read = await h.read();
    expect(parse(read.body)).toMatchObject({ state: 'waiting', inviteId: INVITE_ID });
    expectNoLink(h, res.body, read.body);
  });

  it('refuses an Origin, any Sec-Fetch-* header, a cookie, a CSRF value and a session', async () => {
    const h = await harness();
    for (const extra of [
      { Origin: h.server.origin },
      { Origin: 'http://evil.example' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { 'Sec-Fetch-Mode': 'cors' },
      { 'Sec-Fetch-Dest': 'empty' },
      { Cookie: 'agentlink_1=x' },
      { 'X-AgentLink-CSRF': 'x' },
      { 'X-AgentLink-Input': 'e30' },
      { 'X-AgentLink-Presence': 'passkey' },
      { 'X-AgentLink-Generation': '1' },
    ]) {
      const res = await h.handoff({ invite: LINK }, extra);
      expect(res.status, JSON.stringify(extra)).toBe(403);
      h.advance(5_000);
    }
    expect(parse((await h.read()).body)).toEqual({ state: 'none' });
  });

  it('accepts only the token: missing, wrong or the session token is refused', async () => {
    const h = await harness();
    for (const [extra, omit] of [
      [{}, ['X-AgentLink-Handoff']],
      [{ 'X-AgentLink-Handoff': 'A'.repeat(43) }, []],
      [{ 'X-AgentLink-Handoff': `${h.records[0]?.handoffToken ?? ''}x` }, []],
    ] as const) {
      const res = await h.handoff({ invite: LINK }, extra, omit);
      expect(res.status).toBe(401);
      h.advance(5_000);
    }
    expect(parse((await h.read()).body)).toEqual({ state: 'none' });
  });

  it('needs Host localhost:<port>, octet-stream, no query, and the one body shape', async () => {
    const h = await harness();
    const host127 = await h.handoff({ invite: LINK }, { Host: `127.0.0.1:${String(h.port)}` });
    expect(host127.status).toBe(403);
    h.advance(5_000);
    const json = await h.handoff({ invite: LINK }, { 'Content-Type': 'application/json' });
    expect(json.status).toBe(415);
    h.advance(5_000);
    const query = await h.handoff({ invite: LINK }, {}, [], `${JOIN_HANDOFF_PATH}?invite=x`);
    expect(query.status).toBe(400);
    for (const body of [
      { invite: LINK, extra: 1 },
      { link: LINK },
      [LINK],
      'not json',
      { invite: 7 },
    ]) {
      h.advance(5_000);
      const res = await h.handoff(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    for (const bad of [
      PAYLOAD,
      `http://agentlink.4thtech.io/i#${PAYLOAD}`,
      `${LINK} `,
      `${LINK}%41`,
      `${LINK}#x`,
    ]) {
      h.advance(5_000);
      const res = await h.handoff({ invite: bad });
      expect(res.status).toBe(400);
      expect(parse(res.body)).toEqual({ error: 'invalid_invite' });
      expect(res.body).not.toContain(PAYLOAD.slice(0, 40));
    }
    expect(parse((await h.read()).body)).toEqual({ state: 'none' });
  });

  it('takes at most one handoff per 5 s (429 wait), counted before the token', async () => {
    const h = await harness();
    expect(
      (await h.handoff({ invite: LINK }, { 'X-AgentLink-Handoff': 'B'.repeat(43) })).status,
    ).toBe(401);
    const soon = await h.handoff({ invite: LINK });
    expect(soon.status).toBe(429);
    expect(parse(soon.body)).toEqual({ error: 'wait' });
    expect(soon.headers['retry-after']).toBeDefined();
    h.advance(5_000);
    expect((await h.handoff({ invite: LINK })).status).toBe(200);
  });

  it('refuses invite_waiting while an invite is shown; replaced after Not now or expiry', async () => {
    const h = await harness();
    expect((await h.handoff({ invite: LINK })).status).toBe(200);
    h.advance(5_000);
    const second = await h.handoff({ invite: OTHER_LINK });
    expect(second.status).toBe(409);
    expect(parse(second.body)).toEqual({ error: 'invite_waiting' });
    expect(parse((await h.read()).body)).toMatchObject({ inviteId: INVITE_ID });
    // "Not now" forgets it; the next handoff is taken.
    const dismissed = await h.dismiss();
    expect(dismissed.status).toBe(200);
    expect(parse(dismissed.body)).toEqual({ status: 'dismissed' });
    h.advance(5_000);
    expect((await h.handoff({ invite: OTHER_LINK })).status).toBe(200);
    expect(parse((await h.read()).body)).toMatchObject({ state: 'waiting', inviteId: OTHER_ID });
  });

  it('an expired waiting invite is replaced, and an expired handoff is refused', async () => {
    const h = await harness();
    expect((await h.handoff({ invite: LINK })).status).toBe(200);
    h.advance(EXPIRES_AT * 1000 - 1_790_000_000_000);
    expect(parse((await h.read()).body)).toMatchObject({ state: 'expired' });
    const late = await h.handoff({ invite: OTHER_LINK });
    expect(late.status).toBe(400);
    expect(parse(late.body)).toEqual({ error: 'expired' });
  });

  it('opens the join screen at most once per 30 s', async () => {
    const h = await harness();
    await h.handoff({ invite: LINK });
    await h.dismiss();
    h.advance(5_000);
    const again = await h.handoff({ invite: OTHER_LINK });
    expect(parse(again.body)).toEqual({ status: 'waiting', opened: false });
    expect(h.opened).toHaveLength(1);
  });

  it('runs core Accept step 1 by default: a link whose signatures do not verify is refused', async () => {
    const h = await harness({ realCheck: true });
    const res = await h.handoff({ invite: LINK });
    expect(res.status).toBe(400);
    expect(parse(res.body)).toEqual({ error: 'invalid_invite' });
    expect(parse((await h.read()).body)).toEqual({ state: 'none' });
  });
});

describe('GET /api/ui/join (08 §4)', () => {
  it('answers only the state, inviteId, name, label, fingerprint and expiry', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await h.read();
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({
      state: 'waiting',
      inviteId: INVITE_ID,
      inviter: { name: 'Marko', label: 'self-declared', fingerprint: '7F3A·19C2' },
      expiresAt: '2027-01-15T08:00:00Z',
    });
    expectNoLink(h, res.body);
  });

  it('is `own` for the agent own invite and `already_accepted` for an existing contact', async () => {
    const own = await harness({ waitingInvite: LINK, agentId: CONTACT_ID });
    expect(parse((await own.read()).body)).toMatchObject({ state: 'own' });
    const known = await harness({ waitingInvite: LINK });
    known.core.contacts.push({ id: CONTACT_ID, status: 'active' });
    expect(parse((await known.read()).body)).toMatchObject({ state: 'already_accepted' });
  });

  it('needs the session like every read', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await send(h.port, JOIN_PATH);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ui/join/accept (08 §4)', () => {
  it('a different inviteId is invite_changed before the presence gate: nothing opened or signed', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await h.accept(OTHER_ID, world.code);
    expect(res.status).toBe(409);
    expect(parse(res.body)).toEqual({ error: 'invite_changed' });
    expect(h.core.ownerStores).toBe(0);
    expect(h.core.applied).toHaveLength(0);
    expect(h.core.accepted).toHaveLength(0);
    // No waiting invite at all: the same.
    const none = await harness();
    expect(parse((await none.accept(INVITE_ID, world.code)).body)).toEqual({
      error: 'invite_changed',
    });
  });

  it('needs owner presence: none or a wrong code never reaches core', async () => {
    const h = await harness({ waitingInvite: LINK });
    const missing = await h.accept(INVITE_ID, undefined);
    expect(missing.status).toBe(403);
    const wrong = await h.accept(INVITE_ID, 'AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(wrong.status).toBe(403);
    expect(h.core.accepted).toHaveLength(0);
    expect(h.core.applied).toHaveLength(0);
    expect(parse((await h.read()).body)).toMatchObject({ state: 'waiting' });
  });

  it('a stale generation is agent_changed before anything', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await h.accept(INVITE_ID, world.code, { 'X-AgentLink-Generation': '9' });
    expect(res.status).toBe(409);
    expect(h.core.ownerStores).toBe(0);
  });

  it('with the owner code: one approval.decide by the owner key, used once; the link is dropped', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await h.accept(INVITE_ID, world.code);
    expect(res.status).toBe(200);
    expect(parse(res.body)).toEqual({
      status: 'pending',
      contact: { name: 'Marko', label: 'self-declared', ownerFingerprint: '7F3A·19C2' },
      sent: true,
    });
    expect(h.core.applied).toHaveLength(1);
    const decide = h.core.applied[0] as { body: JsonObject; sig: string };
    expect(decide.body['op']).toBe('approval.decide');
    expect(ownerSigValid(world.owner, decide.body, decide.sig)).toBe(true);
    expect((decide.body['params'] as JsonObject)['decision']).toBe('approve');
    // The same accept action as POST /api/ui/invites/accept (the invite under contacts.acceptInvites).
    const action = (h.core.requested[0] as { action: JsonObject }).action;
    expect(action['tool']).toBe('agentlink_accept_invite');
    expect((action['context'] as JsonObject)['inviteId']).toBe(INVITE_ID);
    expect(h.core.accepted).toEqual([
      { link: LINK, allowed: false },
      { link: LINK, allowed: true },
    ]);
    expect(parse((await h.read()).body)).toMatchObject({ state: 'waiting_for_them' });
    // A second accept finds no invite to take: nothing more is signed.
    const again = await h.accept(INVITE_ID, world.code);
    expect(again.status).toBe(409);
    expect(h.core.applied).toHaveLength(1);
    // Connected once the inviter's agent answered (the contact exists).
    h.core.contacts.push({ id: CONTACT_ID, status: 'active' });
    expect(parse((await h.read()).body)).toMatchObject({ state: 'connected' });
    // After accept, a new handoff is taken (the shown invite was answered).
    expect((await h.handoff({ invite: OTHER_LINK })).status).toBe(200);
    expectNoLink(h, res.body);
  });

  it('an expired waiting invite is refused at accept and signs nothing', async () => {
    const h = await harness({ waitingInvite: LINK });
    h.advance(EXPIRES_AT * 1000 - 1_790_000_000_000);
    const res = await h.accept(INVITE_ID, world.code);
    expect(res.status).toBe(409);
    expect(h.core.applied).toHaveLength(0);
  });
});

describe('POST /api/ui/join/dismiss (08 §4)', () => {
  it('is the invite kind: no owner presence, no owner store, nothing signed', async () => {
    const h = await harness({ waitingInvite: LINK });
    const res = await h.dismiss();
    expect(res.status).toBe(200);
    expect(h.core.ownerStores).toBe(0);
    expect(h.core.applied).toHaveLength(0);
    expect(parse((await h.read()).body)).toEqual({ state: 'none' });
  });

  it('needs the session, CSRF and Origin, and refuses a body other than {}', async () => {
    const h = await harness({ waitingInvite: LINK });
    expect((await h.dismiss({ Cookie: '' })).status).toBe(401);
    expect((await h.dismiss({ Origin: 'http://evil.example' })).status).toBe(403);
    expect((await h.dismiss({ 'X-AgentLink-Generation': '9' })).status).toBe(409);
    expect(parse((await h.read()).body)).toMatchObject({ state: 'waiting' });
  });
});
