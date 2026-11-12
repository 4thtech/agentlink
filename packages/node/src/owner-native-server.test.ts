// DESK-D12c (S2; D-145 phase 2; 04 §2.3.4, §2.5, §2.5.3; 08 §1; I-4, I-7): native presence through
// the approval server, the presence route kind "native" (`X-AgentLink-Presence: native`, empty body).
//
// - `GET /api/owner/native` says whether this computer's helper is there and registered for the owner;
//   `POST /api/owner/native` registers it, its own owner operation (the backup code once).
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
import { OWNER_NATIVE_ACCOUNT } from './owner-native.js';
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
});

interface Harness {
  readonly server: ApprovalServer;
  readonly source: FakeSource;
  readonly port: number;
  readonly helper: StandInHelper;
  readonly routeCalls: number[];
  page(): Promise<Record<string, string>>;
}

async function harness(options: { helper?: StandInHelper | null } = {}): Promise<Harness> {
  const source = fakeSource(world);
  const helper = options.helper ?? new StandInHelper(1);
  const opened: string[] = [];
  const routeCalls: number[] = [];
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

async function decide(
  h: Harness,
  page: Record<string, string>,
  n: number,
  extra: Record<string, string> = NATIVE,
  body?: Uint8Array,
) {
  const row = await h.source.get(approvalId(n));
  return send(h.port, `/api/approvals/${approvalId(n)}/approve`, {
    method: 'POST',
    headers: { ...page, 'X-AgentLink-Digest': row?.actionDigest ?? '0'.repeat(64), ...extra },
    ...(body === undefined ? {} : { body }),
  });
}

describe('GET and POST /api/owner/native', () => {
  it('says available, not registered; registers with the backup code once; then registered', async () => {
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
  it('approves with one helper run (reason approve), signs once, and needs no backup code', async () => {
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
    const res = await send(h.port, '/api/ui/test/c1/check', {
      method: 'POST',
      headers: { ...page, ...NATIVE },
    });
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
    // No 429: the backup code still works right away.
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
    expect(h.helper.calls.map((c) => c.split('@')[0])).toEqual(['release:pay']);
    expect(h.source.applied).toHaveLength(1);
    expect(h.source.applied[0]?.body['params']).toEqual({
      approvalId: approvalId(6),
      actionDigest: row.storedDigest,
      decision: 'approve',
    });
    const again = await finish();
    expect(again.status).toBe(409);
    expect(h.helper.calls).toHaveLength(1);
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
