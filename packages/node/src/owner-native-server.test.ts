// DESK-D12c (S2; D-145 phase 2; 04 §2.3.4, §2.5, §2.5.3; 08 §1; I-4, I-7): native presence through
// the approval server, the presence route kind "native" (`X-AgentLink-Presence: native`, empty body).
//
// - `GET /api/owner/native` says whether this computer's helper is there and registered for the owner;
//   `POST /api/owner/native` registers it, its own owner operation (the master code once).
// - A decision, a review list and an owner route of /api/ui/ accept the native presence: the server
//   runs the helper once with the fixed reason and unlocks the owner store for that one operation.
// - Pay confirm (04 §2.5.3): the statement shown at begin is what the one native unlock signs; the
//   helper's reason is `pay` and display-only; the hold is single use.
// - Helper refusals answer fixed states (cancelled, lockout, reregister, unavailable) and never count
//   towards the wrong-code backoff; a body with the native header, or the native header without a
//   helper, is refused before the owner store is opened.
// The helper is the stand-in of owner-native.fixture.ts; no prompt is shown, no real keychain used.
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  type JsonObject,
  type JsonValue,
} from '@4thtech-io/crypto';
import { canonicalize } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from './approval-server.js';
import {
  approvalId,
  digestOf,
  fakeSource,
  ownerSigValid,
  ownerWorld,
  send,
  type FakeSource,
  type OwnerWorld,
  type RawResponse,
} from './approval-ui.fixture.js';
import type { LocalUiOwnerOperation } from './local-ui/route-types.js';
import { createLocalUiRoutes } from './local-ui/routes.js';
import { TEST_APP } from './local-ui-app.fixture.js';
import { request as httpRequest } from 'node:http';
import { OWNER_NATIVE_ACCOUNT } from './owner-native.js';
import { OWNER_NATIVE_REVOKED_ACCOUNT } from './owner-keystore.js';
import { StandInHelper } from './owner-native.fixture.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-d12c-native-');
}, 60_000);
afterAll(() => world.cleanup());

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await world.keychain.delete(OWNER_NATIVE_ACCOUNT);
  await world.keychain.delete(OWNER_NATIVE_REVOKED_ACCOUNT);
});

interface Harness {
  readonly server: ApprovalServer;
  readonly source: FakeSource;
  readonly port: number;
  readonly helper: StandInHelper;
  readonly routeCalls: number[];
  /** DESK-NATIVE-DEBUG: the diagnostic lines the server wrote. */
  readonly lines: string[];
  page(): Promise<Record<string, string>>;
}

async function harness(options: { helper?: StandInHelper | null } = {}): Promise<Harness> {
  const source = fakeSource(world);
  const helper = options.helper ?? new StandInHelper(1);
  const opened: string[] = [];
  const routeCalls: number[] = [];
  const lines: string[] = [];
  const routes = createLocalUiRoutes();
  routes.register({
    method: 'POST',
    path: '/api/ui/test/:id/check',
    presence: true,
    handler: async (_ctx, req, ownerOp: LocalUiOwnerOperation) => {
      routeCalls.push(1);
      const action = {
        v: 1,
        op: 'contact.check',
        agent: world.agentId,
        owner: encodeHex(world.owner.ownerNostr),
        nonce: 'n'.repeat(22),
        params: { contact: req.params['id'] ?? '' },
      };
      await ownerOp.sign({ lines: ['Mark the safety code as checked'] }, [
        { kind: 'owner-action', action },
      ]);
      return { status: 200, body: { status: 'done' } };
    },
  });
  const server = await startApprovalServerWith(
    {
      source,
      localUi: { assets: TEST_APP },
      ...(options.helper === null ? {} : { nativePresence: helper }),
      diagnose: (line: string) => lines.push(line),
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      routes,
    },
  );
  servers.push(server);
  const port = server.port;
  return {
    server,
    source,
    port,
    helper,
    routeCalls,
    lines,
    async page() {
      const at = opened.length;
      await server.open();
      const token = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const first = await send(port, `/?t=${token}`);
      const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const shell = await send(port, '/', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(shell.body)?.[1];
      return {
        Cookie: cookie,
        Origin: server.origin,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-CSRF': csrf ?? '',
        'Sec-Fetch-Site': 'same-origin',
      };
    },
  };
}

const json = (res: RawResponse): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;
const NATIVE = { 'X-AgentLink-Presence': 'native' };

const register = async (h: Harness, page: Record<string, string>) =>
  send(h.port, '/api/owner/native', {
    method: 'POST',
    headers: page,
    body: encodeUtf8(world.code),
  });

// DESK051-C6 (04 §2.5): native presence answers a ceremony the server issued for exactly this
// request (`X-AgentLink-Presence: native-challenge`, then `native` with `X-AgentLink-Ceremony`).
const NATIVE_CHALLENGE = { 'X-AgentLink-Presence': 'native-challenge' };

/** Asks `path` for a native ceremony with `headers`; the ceremony ID, or the refusal. */
async function nativeCeremony(
  h: Harness,
  path: string,
  headers: Record<string, string>,
): Promise<{ readonly id: string } | { readonly res: RawResponse }> {
  const ask = await send(h.port, path, {
    method: 'POST',
    headers: { ...headers, ...NATIVE_CHALLENGE },
  });
  if (ask.status !== 200) return { res: ask };
  return { id: json(ask)['ceremony'] as string };
}

/** The native request to `path`: a fresh ceremony first, then the request that answers it. */
async function nativeSend(
  h: Harness,
  path: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<RawResponse> {
  const ceremony = await nativeCeremony(h, path, headers);
  if ('res' in ceremony) return ceremony.res;
  return send(h.port, path, {
    method: 'POST',
    headers: { ...headers, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    ...(body === undefined ? {} : { body }),
  });
}

async function decide(
  h: Harness,
  page: Record<string, string>,
  n: number,
  extra: Record<string, string> = NATIVE,
  body?: Uint8Array,
) {
  const row = await h.source.get(approvalId(n));
  const path = `/api/approvals/${approvalId(n)}/approve`;
  const headers = { ...page, 'X-AgentLink-Digest': row?.actionDigest ?? '0'.repeat(64) };
  if (extra === NATIVE) return nativeSend(h, path, headers, body);
  return send(h.port, path, {
    method: 'POST',
    headers: { ...headers, ...extra },
    ...(body === undefined ? {} : { body }),
  });
}

describe('GET and POST /api/owner/native', () => {
  it('says available, not registered; registers with the master code once; then registered', async () => {
    const h = await harness();
    const page = await h.page();
    const before = await send(h.port, '/api/owner/native', { headers: page });
    expect(before.status).toBe(200);
    expect(json(before)).toEqual({
      native: { available: true, registered: false, platform: 'mac' },
    });
    const reg = await register(h, page);
    expect(reg.status).toBe(200);
    expect(json(reg)).toEqual({ status: 'registered' });
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual([
      'create',
      'check',
      'release:setup',
    ]);
    expect(json(await send(h.port, '/api/owner/native', { headers: page }))).toEqual({
      native: { available: true, registered: true, platform: 'mac' },
    });
    const again = await register(h, page);
    expect(again.status).toBe(409);
    expect(json(again)).toEqual({ status: 'native_exists' });
  });

  it('outside the desktop app (no helper) native is not available and registration is refused', async () => {
    const h = await harness({ helper: null });
    const page = await h.page();
    expect(json(await send(h.port, '/api/owner/native', { headers: page }))).toEqual({
      native: { available: false, registered: false },
    });
    const reg = await register(h, page);
    expect(reg.status).toBe(409);
    expect(json(reg)).toEqual({ status: 'native_unavailable' });
  });

  it('a cancelled registration gesture stores nothing and says cancelled', async () => {
    const helper = new StandInHelper(1);
    helper.gesture = 'cancelled';
    const h = await harness({ helper });
    const reg = await register(h, await h.page());
    expect(reg.status).toBe(403);
    expect(json(reg)).toEqual({ status: 'presence_rejected', native: 'cancelled' });
    expect(await world.keychain.get(OWNER_NATIVE_ACCOUNT)).toBeNull();
  });
});

describe('the native presence route kind on decisions and owner routes', () => {
  it('approves with one helper run (reason approve), signs once, and needs no master code', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const row = h.source.add(1);
    const res = await decide(h, page, 1);
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ status: 'applied', decision: 'approve' });
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:approve']);
    const signed = h.source.applied[0];
    expect(signed?.body['params']).toEqual({
      approvalId: approvalId(1),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
    expect(ownerSigValid(world.owner, signed?.body ?? {}, signed?.sig ?? '')).toBe(true);
  });

  it('an owner route of /api/ui/ runs its handler once after one native unlock', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const res = await nativeSend(h, '/api/ui/test/c1/check', page);
    expect(res.status).toBe(200);
    expect(h.routeCalls).toEqual([1]);
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:approve']);
  });

  it('refuses a body with the native header, and the native header without a helper, before unlock', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    h.source.add(2);
    const withBody = await decide(h, page, 2, NATIVE, encodeUtf8(world.code));
    expect(withBody.status).toBe(403);
    expect(json(withBody)['status']).toBe('presence_required');
    expect(h.helper.calls).toEqual([]);
    const none = await harness({ helper: null });
    const p2 = await none.page();
    none.source.add(3);
    const res = await decide(none, p2, 3);
    expect(res.status).toBe(403);
    expect(json(res)).toEqual({ status: 'presence_required', native: 'unavailable' });
  });

  it('helper refusals are fixed states and never start the wrong-code wait', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.source.add(4);
    for (const [state, status] of [
      ['cancelled', 403],
      ['failed', 403],
      ['lockout', 423],
      ['reregister', 409],
      ['unavailable', 409],
      ['cancelled', 403],
    ] as const) {
      h.helper.gesture = state;
      const res = await decide(h, page, 4);
      expect(res.status).toBe(status);
      expect(json(res)).toEqual({ status: 'presence_rejected', native: state });
    }
    // No 429: the master code still works right away.
    const code = await decide(h, page, 4, {}, encodeUtf8(world.code));
    expect(code.status).toBe(200);
    expect(h.source.applied).toHaveLength(1);
  });

  it('without a registration the native header is refused before the helper runs', async () => {
    const h = await harness();
    const page = await h.page();
    h.source.add(5);
    const res = await decide(h, page, 5);
    expect(res.status).toBe(403);
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'not_registered' });
    expect(h.helper.calls).toEqual([]);
  });
});

describe('pay confirm with native presence (04 §2.5.3): the statement is bound in the signed flow', () => {
  const paidAction = (): JsonObject => ({
    tool: 'agentlink_notarize',
    args: { envelopeId: 'E'.repeat(22) },
    context: {
      triggers: ['proofs.perActionMaxUSD'],
      counterparty: { agentId: `0x${'12'.repeat(20)}`, ownerKey: 'cd'.repeat(32) },
      envelopeHash: `0x${'ef'.repeat(32)}`,
      fee: { token: `0x${'ab'.repeat(20)}`, amount: '100000', usd: '0.1' },
    },
  });
  const DETAILS = {
    who: '“Ana” (self-declared)',
    what: 'Record a proof',
    cost: '$0.10',
    expires: '12 Oct 2026 14:02 UTC',
    rule: 'Above your per-proof limit',
    fromAi: [],
  };
  const inputHeader = (value: JsonValue): string =>
    encodeBase64url(encodeUtf8(canonicalize(value)));

  it('begin offers native; finish with one pay gesture signs exactly that approval; the hold is single use', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const action = paidAction();
    const row = h.source.add(6, {
      action,
      actionDigest: digestOf(action),
      storedDigest: digestOf(action),
      summary: 'Record a proof',
      details: DETAILS,
    });
    const begun = await send(h.port, '/api/ui/pay-confirm/begin', {
      method: 'POST',
      headers: {
        ...page,
        'X-AgentLink-Input': inputHeader({ flow: 'proof', approvalId: approvalId(6) }),
      },
    });
    expect(begun.status).toBe(200);
    const b = json(begun);
    expect(b['native']).toBe(true);
    const ceremony = String(b['ceremony']);
    const finish = () =>
      send(h.port, '/api/ui/pay-confirm/finish', {
        method: 'POST',
        headers: { ...page, ...NATIVE, 'X-AgentLink-Input': inputHeader({ ceremony }) },
      });
    const res = await finish();
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ status: 'applied' });
    expect(h.helper.calls.filter((c) => c.startsWith('release'))).toHaveLength(1);
    expect(h.helper.calls.find((c) => c.startsWith('release'))?.split('@')[0]).toBe('release:pay');
    expect(h.source.applied).toHaveLength(1);
    expect(h.source.applied[0]?.body['params']).toEqual({
      approvalId: approvalId(6),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
    const again = await finish();
    expect(again.status).toBe(409);
    expect(h.helper.calls.filter((c) => c.startsWith('release'))).toHaveLength(1);
  });

  it('a cancelled pay gesture uses the hold up and signs nothing', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    const action = paidAction();
    h.source.add(7, {
      action,
      actionDigest: digestOf(action),
      storedDigest: digestOf(action),
      summary: 'Record a proof',
      details: DETAILS,
    });
    const begun = json(
      await send(h.port, '/api/ui/pay-confirm/begin', {
        method: 'POST',
        headers: {
          ...page,
          'X-AgentLink-Input': inputHeader({ flow: 'proof', approvalId: approvalId(7) }),
        },
      }),
    );
    h.helper.gesture = 'cancelled';
    const res = await send(h.port, '/api/ui/pay-confirm/finish', {
      method: 'POST',
      headers: {
        ...page,
        ...NATIVE,
        'X-AgentLink-Input': inputHeader({ ceremony: String(begun['ceremony']) }),
      },
    });
    expect(res.status).toBe(403);
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'cancelled' });
    expect(h.source.applied).toHaveLength(0);
  });
});

describe('Fable review fixes on the server (M1, L1, L4)', () => {
  it('M1: off with the master code, never with native; status then off; on again replaces', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    const viaNative = await send(h.port, '/api/owner/native/off', {
      method: 'POST',
      headers: { ...page, ...NATIVE },
    });
    expect(viaNative.status).toBe(403);
    expect(json(viaNative)['status']).toBe('presence_required');
    const off = await send(h.port, '/api/owner/native/off', {
      method: 'POST',
      headers: page,
      body: encodeUtf8(world.code),
    });
    expect(off.status).toBe(200);
    expect(json(off)).toEqual({ status: 'off' });
    expect(json(await send(h.port, '/api/owner/native', { headers: page }))).toEqual({
      native: { available: true, registered: false, platform: 'mac' },
    });
    const again = await send(h.port, '/api/owner/native/off', {
      method: 'POST',
      headers: page,
      body: encodeUtf8(world.code),
    });
    expect(json(again)).toEqual({ status: 'native_missing' });
    // A biometry change: status says reregister, and replace turns it on again.
    await register(h, page);
    h.helper.checkState = 'reregister';
    expect(json(await send(h.port, '/api/owner/native', { headers: page }))).toEqual({
      native: { available: true, registered: true, reason: 'reregister', platform: 'mac' },
    });
    h.helper.checkState = 'ok';
    const replaced = await send(h.port, '/api/owner/native/replace', {
      method: 'POST',
      headers: page,
      body: encodeUtf8(world.code),
    });
    expect(replaced.status).toBe(200);
    expect(json(replaced)).toEqual({ status: 'registered' });
  });

  it('L1: the page goes away while the prompt is up: busy is released and a late touch approves nothing', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    const row = await (async () => h.source.add(8))();
    let touch: () => void = () => undefined;
    h.helper.touch = new Promise((resolve) => (touch = resolve));
    h.helper.calls.length = 0;
    // DESK051-C6: the native request answers its ceremony.
    const ceremony = await nativeCeremony(h, `/api/approvals/${approvalId(8)}/approve`, {
      ...page,
      'X-AgentLink-Digest': row.actionDigest,
    });
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const req = httpRequest({
      host: '127.0.0.1',
      port: h.port,
      path: `/api/approvals/${approvalId(8)}/approve`,
      method: 'POST',
      headers: {
        Host: `localhost:${String(h.port)}`,
        ...page,
        ...NATIVE,
        'X-AgentLink-Ceremony': ceremony.id,
        'X-AgentLink-Digest': row.actionDigest,
      },
      setHost: false,
    });
    req.on('error', () => undefined);
    req.end();
    while (!h.helper.calls.some((c) => c.startsWith('release')))
      await new Promise((r) => setTimeout(r, 2));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.helper.aborted).toBe(1);
    touch();
    h.helper.touch = undefined;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.source.applied).toHaveLength(0);
    // Not busy any more: the master code decides at once.
    const code = await decide(h, page, 8, {}, encodeUtf8(world.code));
    expect(code.status).toBe(200);
  });

  it('L4: a corrupted blob after a real gesture is "damaged", never the wrong-code wait', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    const blob = (await world.keychain.get(OWNER_NATIVE_ACCOUNT)) ?? new Uint8Array(0);
    blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 1;
    await world.keychain.set(OWNER_NATIVE_ACCOUNT, blob);
    h.source.add(9);
    for (let i = 0; i < 5; i += 1) {
      const res = await decide(h, page, 9);
      expect(res.status).toBe(409);
      expect(json(res)).toEqual({ status: 'presence_rejected', native: 'damaged' });
    }
    const code = await decide(h, page, 9, {}, encodeUtf8(world.code));
    expect(code.status).toBe(200);
  });
});

// DESK-NATIVE-DEBUG: every outcome of turning it on writes ONE fixed diagnostic line (step name and
// fixed reason only, never the master code, a secret or a system message), and a keychain failure
// answers its own state (`keychain`), never the catch-all.
describe('one fixed diagnostic line per outcome (DESK-NATIVE-DEBUG)', () => {
  it('a registration that works: started, then done', async () => {
    const h = await harness();
    const reg = await register(h, await h.page());
    expect(reg.status).toBe(200);
    expect(h.lines).toEqual([
      'native presence: register started',
      'native presence: register done',
    ]);
  });

  it('a cancelled sheet: failed at helper_ecdh with the fixed state', async () => {
    const helper = new StandInHelper(1);
    helper.gesture = 'cancelled';
    const h = await harness({ helper });
    await register(h, await h.page());
    expect(h.lines).toEqual([
      'native presence: register started',
      'native presence: register failed at helper_ecdh (helper_cancelled)',
    ]);
  });

  it('a prompt that timed out answers `timeout`', async () => {
    const helper = new StandInHelper(1);
    helper.gesture = 'timeout';
    const h = await harness({ helper });
    const reg = await register(h, await h.page());
    expect(reg.status).toBe(403);
    expect(json(reg)).toEqual({ status: 'presence_rejected', native: 'timeout' });
  });

  it('a keychain write that fails answers `keychain` and names the step; nothing secret logged', async () => {
    const h = await harness();
    const real = world.keychain.set.bind(world.keychain);
    world.keychain.set = (account: string, value: Uint8Array) =>
      account === OWNER_NATIVE_ACCOUNT
        ? Promise.reject(new Error('the native keychain message'))
        : real(account, value);
    try {
      const reg = await register(h, await h.page());
      expect(reg.status).toBe(503);
      expect(json(reg)).toEqual({ status: 'failed', native: 'keychain' });
    } finally {
      world.keychain.set = real;
    }
    expect(h.lines).toEqual([
      'native presence: register started',
      'native presence: register failed at keychain_write (keychain_failed refused)',
    ]);
    const all = h.lines.join('\n');
    expect(all).not.toContain(world.code);
    expect(all).not.toContain('native keychain message');
  });

  it('a wrong master code: failed at master_code (presence_rejected)', async () => {
    const h = await harness();
    const page = await h.page();
    await send(h.port, '/api/owner/native', {
      method: 'POST',
      headers: page,
      body: encodeUtf8('AAAA BBBB CCCC DDDD EEEE FFFF'),
    });
    expect(h.lines.at(-1)).toBe(
      'native presence: register failed at master_code (presence_rejected)',
    );
  });
});

// DESK-TOUCHID-FIX review round (Fable M-1, L-2, L-1): Cancel on the page asks the server to cancel
// (POST /api/owner/native/cancel); the server stops the helper of the operation in progress (turn on,
// on again, or a native approval), releases `busy`, stores nothing, and the page gets the server's
// own answer. A replace that fails after the old one was removed says so (`nowOff`). A keychain
// write that timed out and may still land is never reported as "nothing changed".
describe('cancel, replace wording and a late keychain write (DESK-TOUCHID-FIX review)', () => {
  const cancel = (h: Harness, page: Record<string, string>) =>
    send(h.port, '/api/owner/native/cancel', { method: 'POST', headers: page });
  const untilReleasing = async (h: Harness): Promise<void> => {
    while (!h.helper.calls.some((c) => c.startsWith('release')))
      await new Promise((r) => setTimeout(r, 2));
  };

  it('cancel during turn-on: helper stopped, busy released, nothing stored, server says cancelled', async () => {
    const h = await harness();
    const page = await h.page();
    h.helper.touch = new Promise(() => undefined);
    h.helper.stopOnAbort = true;
    const pending = register(h, page);
    await untilReleasing(h);
    const c = await cancel(h, page);
    expect(c.status).toBe(200);
    expect(json(c)).toEqual({ status: 'cancelling' });
    const reg = await pending;
    expect(h.helper.aborted).toBe(1);
    expect(reg.status).toBe(403);
    expect(json(reg)).toEqual({ status: 'presence_rejected', native: 'cancelled' });
    expect(await world.keychain.get(OWNER_NATIVE_ACCOUNT)).toBeNull();
    h.helper.touch = undefined;
    // Not busy any more.
    const again = await register(h, page);
    expect(json(again)).toEqual({ status: 'registered' });
  });

  it('cancel during on-again: helper stopped, nothing new stored, and the answer says it is now off', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    h.helper.touch = new Promise(() => undefined);
    h.helper.stopOnAbort = true;
    const pending = send(h.port, '/api/owner/native/replace', {
      method: 'POST',
      headers: page,
      body: encodeUtf8(world.code),
    });
    await untilReleasing(h);
    await cancel(h, page);
    const res = await pending;
    expect(h.helper.aborted).toBe(1);
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'cancelled', nowOff: true });
    expect(await world.keychain.get(OWNER_NATIVE_ACCOUNT)).toBeNull();
  });

  it('a page that goes away during turn-on also stops the helper and stores nothing', async () => {
    const h = await harness();
    const page = await h.page();
    h.helper.touch = new Promise(() => undefined);
    h.helper.stopOnAbort = true;
    const req = httpRequest({
      host: '127.0.0.1',
      port: h.port,
      path: '/api/owner/native',
      method: 'POST',
      headers: { Host: `localhost:${String(h.port)}`, ...page },
      setHost: false,
    });
    req.on('error', () => undefined);
    req.end(Buffer.from(encodeUtf8(world.code)));
    await untilReleasing(h);
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.helper.aborted).toBe(1);
    expect(await world.keychain.get(OWNER_NATIVE_ACCOUNT)).toBeNull();
    h.helper.touch = undefined;
    expect(json(await register(h, page))).toEqual({ status: 'registered' });
  });

  it('cancel during a native approval gives the server answer (cancelled); with nothing running, none', async () => {
    const h = await harness();
    const page = await h.page();
    expect(json(await cancel(h, page))).toEqual({ status: 'none' });
    await register(h, page);
    h.source.add(12);
    h.helper.calls.length = 0;
    h.helper.touch = new Promise(() => undefined);
    h.helper.stopOnAbort = true;
    const pending = decide(h, page, 12);
    await untilReleasing(h);
    await cancel(h, page);
    const res = await pending;
    expect(json(res)['native']).toBe('cancelled');
    expect(h.source.applied).toHaveLength(0);
  });

  it('cancel needs the page session and CSRF token', async () => {
    const h = await harness();
    const page = await h.page();
    const bad = await send(h.port, '/api/owner/native/cancel', {
      method: 'POST',
      headers: { ...page, 'X-AgentLink-CSRF': 'x' },
    });
    expect(bad.status).toBe(403);
  });

  it('replace that fails after removing the old one says it is now off (timeout, keychain)', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.gesture = 'timeout';
    const res = await send(h.port, '/api/owner/native/replace', {
      method: 'POST',
      headers: page,
      body: encodeUtf8(world.code),
    });
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'timeout', nowOff: true });
    h.helper.gesture = 'ok';
    // A wrong master code changed nothing: no nowOff.
    const wrong = await send(h.port, '/api/owner/native/replace', {
      method: 'POST',
      headers: page,
      body: encodeUtf8('WRONG-CODE-0000'),
    });
    expect(json(wrong)['nowOff']).toBeUndefined();
  });
});

// DESK051-C2 (04 §2.5 "Touch ID & master code page"; 08 §1): the owner-code steps with the native
// presence kind. Test Touch ID in the desktop app is the native gesture (it opens `ALKH`, so "works"
// means native approvals will work) and signs nothing; Replace takes any presence; Check and the new
// code typed back are about the typed master code, so native is refused there before the helper runs.
describe('owner-code steps with native presence (DESK051-C2)', () => {
  const CODE_STEP = { 'X-AgentLink-Input': 'e30' }; // base64url of `{}`
  const post = (
    h: Harness,
    page: Record<string, string>,
    path: string,
    extra: Record<string, string> = NATIVE,
  ) =>
    extra === NATIVE
      ? nativeSend(h, path, { ...page, ...CODE_STEP })
      : send(h.port, path, { method: 'POST', headers: { ...page, ...CODE_STEP, ...extra } });

  it('Test Touch ID accepts native: one helper run, done, signs nothing', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const res = await post(h, page, '/api/ui/owner-presence/test');
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ status: 'done' });
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:approve']);
    expect(h.source.applied).toEqual([]);
  });

  it('Test Touch ID with native but nothing turned on: not_registered, helper not run', async () => {
    const h = await harness();
    const page = await h.page();
    const res = await post(h, page, '/api/ui/owner-presence/test');
    expect(res.status).toBe(403);
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'not_registered' });
    expect(h.helper.calls).toEqual([]);
  });

  it('a cancelled Test gesture is a fixed state, never the wrong-code wait', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.gesture = 'cancelled';
    const res = await post(h, page, '/api/ui/owner-presence/test');
    expect(res.status).toBe(403);
    expect(json(res)).toEqual({ status: 'presence_rejected', native: 'cancelled' });
    h.helper.gesture = 'ok';
    const again = await post(h, page, '/api/ui/owner-presence/test');
    expect(again.status).toBe(200);
  });

  it('Replace master code accepts native and stages a new code', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const res = await post(h, page, '/api/ui/owner-code/replace');
    expect(res.status).toBe(200);
    expect(json(res)['status']).toBe('staged');
    // D15-04: the OS sheet names the operation (reason id `code`), not a routine approval.
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:code']);
    const drop = await post(h, page, '/api/ui/owner-code/replace/cancel', {});
    expect(json(drop)['status']).toBe('cancelled');
  });

  it('Check and finish refuse native before the helper runs; Cancel refuses any presence header', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    for (const path of [
      '/api/ui/owner-code/check',
      '/api/ui/owner-code/replace/finish',
      '/api/ui/owner-code/replace/cancel',
    ]) {
      // The bare native header (no ceremony) is refused at the step's proof rule…
      const res = await send(h.port, path, {
        method: 'POST',
        headers: { ...page, ...CODE_STEP, ...NATIVE },
      });
      expect(res.status, path).toBe(403);
      expect(json(res)['status'], path).toBe('presence_required');
      // …and no native ceremony is issued for these steps (DESK051-C6).
      const ask = await send(h.port, path, {
        method: 'POST',
        headers: { ...page, ...CODE_STEP, ...NATIVE_CHALLENGE },
      });
      expect(ask.status, path).not.toBe(200);
    }
    expect(h.helper.calls).toEqual([]);
  });
});

// DESK051-C6 (04 §2.5 "each gesture unlocks the owner key for exactly one owner operation"; REL051-SF1
// presence ceremony; I-4): every native gesture answers a fresh, single-use ceremony the server issued
// for this page session and exactly this request. The ceremony is spent before the helper runs, so a
// captured or replayed native request never starts a second OS sheet and never acts.
describe('native presence answers a fresh ceremony per gesture (DESK051-C6)', () => {
  const TEST_PATH = '/api/ui/owner-presence/test';
  const CODE_STEP = { 'X-AgentLink-Input': 'e30' };

  it('the challenge answers a ceremony ID only, runs no helper and opens nothing', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const ask = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE_CHALLENGE },
    });
    expect(ask.status).toBe(200);
    const answer = json(ask);
    expect(answer['status']).toBe('ready');
    expect(answer['ceremony']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(answer['publicKey']).toBeUndefined();
    expect(h.helper.calls).toEqual([]);
    expect(h.routeCalls).toEqual([]);
  });

  it('outside the desktop app (no helper) no native ceremony is issued', async () => {
    const h = await harness({ helper: null });
    const page = await h.page();
    const ask = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE_CHALLENGE },
    });
    expect(ask.status).toBe(403);
    expect(json(ask)).toEqual({ status: 'presence_required', native: 'unavailable' });
  });

  it('a native request without a ceremony is refused before the helper runs', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const row = h.source.add(20);
    const decided = await send(h.port, `/api/approvals/${approvalId(20)}/approve`, {
      method: 'POST',
      headers: { ...page, 'X-AgentLink-Digest': row.storedDigest, ...NATIVE },
    });
    expect(decided.status).toBe(403);
    expect(json(decided)['status']).toBe('presence_required');
    const route = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE },
    });
    expect(route.status).toBe(403);
    expect(json(route)['status']).toBe('presence_required');
    const test = await send(h.port, TEST_PATH, {
      method: 'POST',
      headers: { ...page, ...CODE_STEP, ...NATIVE },
    });
    expect(test.status).toBe(403);
    expect(json(test)['status']).toBe('presence_required');
    expect(h.helper.calls).toEqual([]);
    expect(h.routeCalls).toEqual([]);
    expect(h.source.applied).toEqual([]);
  });

  it('a replayed native request is refused: its ceremony was spent by the first', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const ceremony = await nativeCeremony(h, '/api/ui/test/c1/check', page);
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const request = {
      method: 'POST',
      headers: { ...page, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    };
    const first = await send(h.port, '/api/ui/test/c1/check', request);
    expect(first.status).toBe(200);
    const replay = await send(h.port, '/api/ui/test/c1/check', request);
    expect(replay.status).toBe(403);
    expect(json(replay)['status']).toBe('presence_required');
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:approve']);
    expect(h.routeCalls).toEqual([1]);
  });

  it('a replayed Test Touch ID and a replayed decision are refused before the helper runs', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const test = await nativeCeremony(h, TEST_PATH, { ...page, ...CODE_STEP });
    if (!('id' in test)) throw new Error('no ceremony');
    const testRequest = {
      method: 'POST',
      headers: { ...page, ...CODE_STEP, ...NATIVE, 'X-AgentLink-Ceremony': test.id },
    };
    expect((await send(h.port, TEST_PATH, testRequest)).status).toBe(200);
    const again = await send(h.port, TEST_PATH, testRequest);
    expect(again.status).toBe(403);
    expect(json(again)['status']).toBe('presence_required');
    const row = h.source.add(21);
    const path = `/api/approvals/${approvalId(21)}/deny`;
    const headers = { ...page, 'X-AgentLink-Digest': row.storedDigest };
    const ceremony = await nativeCeremony(h, path, headers);
    if (!('id' in ceremony))
      throw new Error(`no ceremony ${ceremony.res.status} ${ceremony.res.body}`);
    const request = {
      method: 'POST',
      headers: { ...headers, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    };
    // A gesture that was cancelled still spends the ceremony: the retry needs a new one.
    h.helper.gesture = 'cancelled';
    expect(json(await send(h.port, path, request))).toEqual({
      status: 'presence_rejected',
      native: 'cancelled',
    });
    h.helper.gesture = 'ok';
    const replay = await send(h.port, path, request);
    expect(replay.status).toBe(403);
    expect(json(replay)['status']).toBe('presence_required');
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual([
      'release:approve',
      'release:approve',
    ]);
    expect(h.source.applied).toEqual([]);
  });

  it('a ceremony for one request does not answer another, and is spent by the attempt', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const ceremony = await nativeCeremony(h, '/api/ui/test/c1/check', page);
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const other = await send(h.port, '/api/ui/test/c2/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    });
    expect(other.status).toBe(403);
    expect(json(other)['status']).toBe('presence_required');
    const own = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    });
    expect(own.status).toBe(403);
    expect(h.helper.calls).toEqual([]);
    expect(h.routeCalls).toEqual([]);
  });

  it('another page session cannot use the ceremony', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const ceremony = await nativeCeremony(h, '/api/ui/test/c1/check', page);
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const second = await h.page();
    const res = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...second, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    });
    expect(res.status).toBe(403);
    expect(json(res)['status']).toBe('presence_required');
    expect(h.helper.calls).toEqual([]);
    expect(h.routeCalls).toEqual([]);
  });

  it('a native ceremony never answers a passkey proof (and is spent by the attempt)', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const ceremony = await nativeCeremony(h, '/api/ui/test/c1/check', page);
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const passkey = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: {
        ...page,
        'X-AgentLink-Presence': 'passkey',
        'X-AgentLink-Ceremony': ceremony.id,
      },
      body: new Uint8Array(64).fill(1),
    });
    expect(passkey.status).toBe(403);
    const native = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    });
    expect(native.status).toBe(403);
    expect(json(native)['status']).toBe('presence_required');
    expect(h.helper.calls).toEqual([]);
    expect(h.routeCalls).toEqual([]);
  });

  it('Replace master code with native answers a ceremony too (reason code)', async () => {
    const h = await harness();
    const page = await h.page();
    await register(h, page);
    h.helper.calls.length = 0;
    const path = '/api/ui/owner-code/replace';
    const ceremony = await nativeCeremony(h, path, { ...page, ...CODE_STEP });
    if (!('id' in ceremony)) throw new Error('no ceremony');
    const request = {
      method: 'POST',
      headers: { ...page, ...CODE_STEP, ...NATIVE, 'X-AgentLink-Ceremony': ceremony.id },
    };
    expect(json(await send(h.port, path, request))['status']).toBe('staged');
    await send(h.port, '/api/ui/owner-code/replace/cancel', {
      method: 'POST',
      headers: { ...page, ...CODE_STEP },
    });
    const replay = await send(h.port, path, request);
    expect(replay.status).toBe(403);
    expect(json(replay)['status']).toBe('presence_required');
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:code']);
  });
});
