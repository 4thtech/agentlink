// UX2-d1 acceptance: the invite routes behind the approval server's gates (08 §1; 04 §2.5, §3.6,
// §4; b11 §21; owner decision 1.1; I-1, I-4, I-5, I-7).
//
// - Create and check (`presence: 'invite'`) run behind the session cookie, the CSRF header, the
//   page's Origin, same-origin fetch metadata and an octet-stream body, with no owner presence and no
//   owner store. No query, no operation input and no presence header. Creating is rate-limited.
// - Accept (`presence: true`) runs only behind the central owner-presence gate: no proof or a wrong
//   one never reaches core; with the owner code, one `approval.decide` is signed by the real owner key
//   and core pairs once.
// - The invite link (its secret) appears in no event, no console output and no error answer.
import { deflateRawSync } from 'node:zlib';
import {
  INVITE_LINK_PREFIX,
  decodeInviteLink,
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalForDecision,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { LocalUiAssets } from './context.js';
import { INVITE_ACCEPT_PATH, INVITE_CHECK_PATH, INVITE_CREATE_PATH } from './invite-paths.js';

const hex = (n: number, pair: string): string => pair.repeat(n);

/** A schema-valid invite (04 §3.6); signatures are shape-only, the fake core does not check them. */
const inviteObject = (
  relays: string[] = ['wss://relay.example.org', 'wss://nos.example.net:7447/sub/path'],
) => ({
  v: 1,
  inviteId: encodeBase64url(new Uint8Array(16).fill(1)),
  secret: encodeBase64url(new Uint8Array(32).fill(2)),
  card: {
    version: 1,
    agentEvm: `0x${hex(20, '1a')}`,
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
  relays,
  expiresAt: 1_800_000_000,
});

let world: OwnerWorld;
let LINK = '';
let PAYLOAD = '';
/** The same invite naming loopback relays, packed as the codec packs (it never encodes one). */
let SSRF_LINK = '';

beforeAll(async () => {
  world = await ownerWorld('agentlink-ux2-d1-');
  LINK = await encodeInviteLink(inviteObject() as never);
  PAYLOAD = LINK.slice(INVITE_LINK_PREFIX.length);
  SSRF_LINK = `${INVITE_LINK_PREFIX}${encodeBase64url(
    deflateRawSync(
      encodeUtf8(JSON.stringify(inviteObject(['wss://127.0.0.1:7447', 'ws://169.254.169.254']))),
    ),
  )}`;
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
  id: `0x${hex(20, '1a')}`,
  display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' },
  ownerFingerprint: { short: 'AB12·CD34', long: 'AB12CD34'.repeat(8) },
  pairing: 'pending',
  safetyCodeChecked: false,
};
const APPROVAL = `apr_${'Q'.repeat(22)}`;

interface Core {
  created: unknown[];
  accepted: { link: string; allowed: boolean }[];
  requested: unknown[];
  used: unknown[];
  applied: { body: JsonObject; sig: string }[];
  ownerStores: number;
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly core: Core;
  readonly events: ApprovalServerEvent[];
  readonly origin: string;
  readonly port: number;
  setNow(ms: number): void;
  post(
    path: string,
    body: Uint8Array | undefined,
    extra?: Record<string, string>,
    omit?: readonly string[],
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }>;
}

async function harness(): Promise<Harness> {
  const core: Core = {
    created: [],
    accepted: [],
    requested: [],
    used: [],
    applied: [],
    ownerStores: 0,
  };
  let stored: ApprovalForDecision | undefined;
  const client = {
    agentId: world.agentId,
    pairing: {
      createInvite: (input: unknown) => {
        core.created.push(input);
        return Promise.resolve({
          inviteUrl: LINK,
          ownerFingerprint: { short: 'EF56·7890', long: 'EF567890'.repeat(8) },
          expiresAt: 1_793_786_400,
        });
      },
      acceptInvite: async ({ link, allowed }: { link: string; allowed?: boolean }) => {
        // The real codec runs first, as core's accept step 1 does.
        await decodeInviteLink(link);
        core.accepted.push({ link, allowed: allowed === true });
        return allowed === true
          ? { status: 'pending', contact: CONTACT, pairingId: 'p1', handshake: {} }
          : { status: 'pending_approval', contact: CONTACT };
      },
    },
    ownerActions: {
      loadPolicy: () => Promise.resolve({ mode: 'fail_closed', problem: 'missing' }),
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
      use: (...args: unknown[]) => {
        core.used.push(args);
        return Promise.resolve({ status: core.applied.length === 1 ? 'used' : 'void' });
      },
    },
    outbox: {
      processDue: () => Promise.resolve({ sent: 1, failed: 0, notDelivered: 0 }),
    },
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
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  let clock = 1_790_000_000_000;
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (e) => events.push(e),
      localUi: { assets: bundle(), client: client as never },
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
  return {
    core,
    events,
    origin: server.origin,
    port,
    setNow: (ms) => {
      clock = ms;
    },
    post: (path, body, extra = {}, omit = []) => {
      const headers: Record<string, string> = {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        ...extra,
      };
      for (const name of omit) Reflect.deleteProperty(headers, name);
      return send(port, path, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body }),
      }) as never;
    },
  };
}

const json = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));
const input = (value: unknown): string => encodeBase64url(json(value));

/** The base variants every invite route must refuse: no session, CSRF, Origin or same-origin. */
const GATE_VARIANTS: [Record<string, string>, readonly string[], number][] = [
  [{}, ['Cookie'], 401],
  [{}, ['X-AgentLink-CSRF'], 403],
  [{ 'X-AgentLink-CSRF': 'x' }, [], 403],
  [{}, ['Origin'], 403],
  [{ Origin: 'http://evil.example' }, [], 403],
  [{ 'Sec-Fetch-Site': 'cross-site' }, [], 403],
  [{ 'Sec-Fetch-Site': 'same-site' }, [], 403],
  [{ 'Content-Type': 'text/plain' }, [], 415],
  [{ 'Content-Type': 'application/json' }, [], 415],
];

describe('create an invite: no owner presence, its own gate (UX2-d1, decision 1.1)', () => {
  it('creates with no owner presence and no owner store, answering the link only to the page', async () => {
    const h = await harness();
    const res = await h.post(INVITE_CREATE_PATH, json({ label: 'Marko' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      inviteUrl: LINK,
      ownerFingerprint: 'EF56·7890',
      expiresAt: '2026-11-04T10:00:00Z',
    });
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(h.core.created).toEqual([{ label: 'Marko' }]);
    expect(h.core.ownerStores).toBe(0);
  });

  it('needs the session, CSRF, Origin, same-origin metadata and an octet-stream body', async () => {
    const h = await harness();
    for (const [extra, omit, status] of GATE_VARIANTS) {
      const res = await h.post(INVITE_CREATE_PATH, json({}), extra, omit);
      expect(res.status, JSON.stringify({ extra, omit })).toBe(status);
    }
    const get = await send(h.port, INVITE_CREATE_PATH);
    expect([401, 405]).toContain(get.status);
    expect(h.core.created).toHaveLength(0);
  });

  it('refuses a query, an operation input or a presence header before anything runs', async () => {
    const h = await harness();
    for (const [extra, path] of [
      [{ 'X-AgentLink-Input': input({ label: 'x' }) }, INVITE_CREATE_PATH],
      [{ 'X-AgentLink-Presence': 'passkey' }, INVITE_CREATE_PATH],
      [{}, `${INVITE_CREATE_PATH}?label=Marko`],
    ] as const) {
      const res = await h.post(path, json({}), extra);
      expect(res.status, path).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid' });
    }
    expect(h.core.created).toHaveLength(0);
  });

  it('refuses a body that is not strict JSON, or an oversized one', async () => {
    const h = await harness();
    for (const raw of ['', 'not json', '{"label":"a","label":"b"}', '[]', 'null']) {
      const res = await h.post(INVITE_CREATE_PATH, encodeUtf8(raw));
      expect(res.status, raw).toBe(400);
    }
    const big = await h.post(INVITE_CREATE_PATH, json({ label: 'x'.repeat(4096) }));
    expect(big.status).toBe(413);
    expect(h.core.created).toHaveLength(0);
  });

  it('is rate-limited: at most 10 invites in 10 minutes, then 429 with Retry-After', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i += 1) {
      expect((await h.post(INVITE_CREATE_PATH, json({}))).status, String(i)).toBe(200);
    }
    const held = await h.post(INVITE_CREATE_PATH, json({}));
    expect(held.status).toBe(429);
    expect(JSON.parse(held.body)).toMatchObject({ error: 'wait' });
    expect(Number(held.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.core.created).toHaveLength(10);
    h.setNow(1_790_000_000_000 + 10 * 60_000 + 1);
    expect((await h.post(INVITE_CREATE_PATH, json({}))).status).toBe(200);
  });
});

describe('check an invite: no owner presence, stores nothing (UX2-d1, b11 §21.4)', () => {
  it('answers who it is, with no owner store and no pairing started', async () => {
    const h = await harness();
    const res = await h.post(INVITE_CHECK_PATH, json({ invite: LINK }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      contact: { name: 'Marko', label: 'self-declared', ownerFingerprint: 'AB12·CD34' },
    });
    expect(res.body).not.toContain(PAYLOAD);
    expect(h.core.accepted).toEqual([{ link: LINK, allowed: false }]);
    expect(h.core.ownerStores).toBe(0);
  });

  it('refuses an invite naming loopback or link-local relays (04 §4), with a fixed code', async () => {
    const h = await harness();
    const res = await h.post(INVITE_CHECK_PATH, json({ invite: SSRF_LINK }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_invite' });
    expect(h.core.accepted).toHaveLength(0);
  });

  it('needs the same gate as create', async () => {
    const h = await harness();
    for (const [extra, omit, status] of GATE_VARIANTS) {
      const res = await h.post(INVITE_CHECK_PATH, json({ invite: LINK }), extra, omit);
      expect(res.status, JSON.stringify({ extra, omit })).toBe(status);
    }
    expect(h.core.accepted).toHaveLength(0);
  });
});

describe('accept an invite: owner presence required (UX2-d1, decision 1.1)', () => {
  it('refuses without owner presence before core reads the invite', async () => {
    const h = await harness();
    const headers = { 'X-AgentLink-Input': input({ invite: LINK }) };
    const none = await h.post(INVITE_ACCEPT_PATH, undefined, headers);
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toEqual({ status: 'presence_required' });
    const badPasskey = await h.post(INVITE_ACCEPT_PATH, encodeUtf8('not an assertion'), {
      ...headers,
      'X-AgentLink-Presence': 'passkey',
    });
    expect(badPasskey.status).toBe(403);
    const wrong = await h.post(
      INVITE_ACCEPT_PATH,
      encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'),
      headers,
    );
    expect(wrong.status).toBe(403);
    expect(JSON.parse(wrong.body)).toEqual({ status: 'presence_rejected' });
    expect(h.core.accepted).toHaveLength(0);
    expect(h.core.requested).toHaveLength(0);
    expect(h.core.applied).toHaveLength(0);
  });

  it('needs the session, CSRF, Origin and same-origin metadata too', async () => {
    const h = await harness();
    const headers = { 'X-AgentLink-Input': input({ invite: LINK }) };
    for (const [extra, omit, status] of GATE_VARIANTS) {
      const res = await h.post(
        INVITE_ACCEPT_PATH,
        encodeUtf8(world.code),
        { ...headers, ...extra },
        omit,
      );
      expect(res.status, JSON.stringify({ extra, omit })).toBe(status);
    }
    expect(h.core.accepted).toHaveLength(0);
  });

  it('with the owner code: one approval.decide by the owner key, applied, then one pairing', async () => {
    const h = await harness();
    const res = await h.post(INVITE_ACCEPT_PATH, encodeUtf8(world.code), {
      'X-AgentLink-Input': input({ invite: LINK }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'pending',
      contact: { name: 'Marko', label: 'self-declared', ownerFingerprint: 'AB12·CD34' },
      sent: true,
    });
    expect(res.body).not.toContain(PAYLOAD);
    expect(h.core.applied).toHaveLength(1);
    const decide = h.core.applied[0] as { body: JsonObject; sig: string };
    expect(decide.body['op']).toBe('approval.decide');
    expect(ownerSigValid(world.owner, decide.body, decide.sig)).toBe(true);
    expect((decide.body['params'] as JsonObject)['approvalId']).toBe(APPROVAL);
    expect((decide.body['params'] as JsonObject)['decision']).toBe('approve');
    expect(h.core.accepted).toEqual([
      { link: LINK, allowed: false },
      { link: LINK, allowed: true },
    ]);
  });

  it('an invite naming loopback relays is refused and nothing is signed', async () => {
    const h = await harness();
    const res = await h.post(INVITE_ACCEPT_PATH, encodeUtf8(world.code), {
      'X-AgentLink-Input': input({ invite: SSRF_LINK }),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'refused' });
    expect(h.core.applied).toHaveLength(0);
    expect(h.core.requested).toHaveLength(0);
  });
});

describe('the invite link is never logged (UX2-d1, I-7)', () => {
  it('no event, console line or error answer carries the link', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const h = await harness();
    const answers: string[] = [];
    answers.push((await h.post(INVITE_CREATE_PATH, json({ label: 'Marko' }))).body);
    answers.push((await h.post(INVITE_CHECK_PATH, json({ invite: LINK }))).body);
    answers.push((await h.post(INVITE_CHECK_PATH, json({ invite: `${LINK}x!` }))).body);
    answers.push((await h.post(INVITE_CHECK_PATH, json({ invite: SSRF_LINK }))).body);
    const accept = { 'X-AgentLink-Input': input({ invite: LINK }) };
    answers.push((await h.post(INVITE_ACCEPT_PATH, undefined, accept)).body);
    answers.push((await h.post(INVITE_ACCEPT_PATH, encodeUtf8(world.code), accept)).body);
    const secret = inviteObject().secret;
    const logged = JSON.stringify(h.events) + lines.join('\n');
    for (const needle of [PAYLOAD, PAYLOAD.slice(0, 40), secret, SSRF_LINK.slice(-40)]) {
      expect(logged).not.toContain(needle);
    }
    // Only the create answer carries the link, to the page that asked for it.
    expect(answers.filter((a) => a.includes(PAYLOAD.slice(0, 40)))).toHaveLength(1);
  });
});
