// RET-4 (S2; D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet"; I-4): Delete history end
// to end through the approval server's real gates, with the real owner store and master code. Core's
// history service is a small fake that records what it is asked to plan and apply.
//
// - begin (the history kind): session cookie, CSRF, Origin and an octet-stream JSON body; no
//   presence. The server computes the plan itself and keeps it in a ticket of this page session.
// - finish (`presence: true`): the central gate verifies presence before the route runs; the body is
//   the proof and the input is exactly `{nonce}`, so the page cannot name any other list.
// - The apply waits for the Undo window; Undo inside it applies nothing.
// - Nothing here is an MCP tool: a request without the page session or CSRF is refused (I-4).
import type { HistoryDeleteInput, HistoryDeletePlan, HistoryDeleteResult } from '@4thtech-io/core';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import { LocalUiRouteRegistry } from './routes.js';

// The fixed paths (08 §1), spelled out so this suite does not depend on the module under test.
const BEGIN = '/api/ui/history/delete/begin';
const FINISH = '/api/ui/history/delete/finish';
const UNDO = '/api/ui/history/delete/undo';
const STATUS = '/api/ui/history/delete/status';
const ALICE = `0x${'a'.repeat(40)}`;
const BOB = `0x${'b'.repeat(40)}`;
const UNDO_MS = 150;

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-ret4-');
});
afterAll(() => {
  world.cleanup();
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const RESULT: HistoryDeleteResult = {
  messages: { deleted: 3, notarized: 0, kept: 0 },
  files: { trashed: 2, changed: 0, missing: 0, refused: 0, noTrash: 0, failed: 0 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness() {
  const state = {
    hash: 'plan-1',
    planned: [] as HistoryDeleteInput[],
    applied: [] as HistoryDeletePlan[],
  };
  const client = {
    agentId: world.agentId,
    ownerActions: { loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }) },
    history: {
      plan: (input: HistoryDeleteInput): Promise<HistoryDeletePlan> => {
        state.planned.push(input);
        return Promise.resolve({
          input,
          include: input.include,
          planHash: state.hash,
          envelopeIds: ['m1', 'm2', 'm3'],
          messages: { count: 3, bytes: 3000 },
          notarized: 0,
          files: { count: 2, bytes: 2_000_000 },
          savedFiles: [
            { envelopeId: 'm1', index: 0 },
            { envelopeId: 'm2', index: 0 },
          ],
          kept: {
            count: 1,
            by: { pairing: 1, terms: 0, approval: 0, outbox: 0, ledger: 0, receipt: 0 },
          },
          truncated: false,
        });
      },
      apply: (plan: HistoryDeletePlan): Promise<HistoryDeleteResult> => {
        state.applied.push(plan);
        return Promise.resolve(RESULT);
      },
    },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.resolve({ status: 'refused', op: 'x', reason: 'x' } as never),
  };
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    { source, localUi: { assets: TEST_APP, client: client as never } },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      historyUndoMs: UNDO_MS,
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Content-Type': 'application/octet-stream',
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  });
  const json = async (path: string, body: unknown, extra?: Record<string, string>) => {
    const res = await send(server.port, path, {
      method: 'POST',
      headers: headers(extra),
      body: encodeUtf8(JSON.stringify(body)),
    });
    return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> };
  };
  const finish = async (input: unknown, code: string) => {
    const res = await send(server.port, FINISH, {
      method: 'POST',
      headers: headers({
        'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify(input))),
      }),
      body: encodeUtf8(code),
    });
    return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> };
  };
  const begin = async (body: unknown) => {
    const res = await json(BEGIN, body);
    return { ...res, nonce: String(res.json['nonce'] ?? '') };
  };
  return { state, server, cookie, csrf, headers, json, begin, finish };
}

describe('Delete history through the real gates (RET-4)', () => {
  it('begin plans on the server and answers counts and sizes only; nothing is deleted', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'both' });
    expect(begun.status).toBe(200);
    expect(begun.json).toMatchObject({
      status: 'planned',
      messages: { count: 3, bytes: 3000 },
      files: { count: 2, bytes: 2_000_000 },
      kept: 1,
      undoSeconds: 10,
    });
    expect(JSON.stringify(begun.json)).not.toContain('plan-1');
    expect(JSON.stringify(begun.json)).not.toContain('m1');
    expect(h.state.planned).toEqual([{ contactId: ALICE, include: 'both' }]);
    expect(h.state.applied).toEqual([]);
  });

  it('finish needs presence: no proof or a wrong master code schedules and applies nothing', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'both' });
    const wrong = await h.finish({ nonce: begun.nonce }, 'AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(wrong.status).toBe(403);
    const bogus = await send(h.server.port, FINISH, {
      method: 'POST',
      headers: h.headers({
        'X-AgentLink-Presence': 'nope',
        'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify({ nonce: begun.nonce }))),
      }),
      body: new Uint8Array(0),
    });
    expect(bogus.status).toBe(403);
    await sleep(UNDO_MS * 3);
    expect(h.state.applied).toEqual([]);
    expect((await h.json(STATUS, { nonce: begun.nonce })).json).toEqual({ status: 'planned' });
  });

  it('with presence, the bound plan applies when the Undo window ends', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'both' });
    const done = await h.finish({ nonce: begun.nonce }, world.code);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ status: 'done', undoSeconds: 10 });
    expect(h.state.applied).toEqual([]);
    expect((await h.json(STATUS, { nonce: begun.nonce })).json).toEqual({ status: 'scheduled' });
    await sleep(UNDO_MS * 3);
    expect(h.state.applied).toHaveLength(1);
    expect(h.state.applied[0]?.planHash).toBe('plan-1');
    expect(h.state.applied[0]?.input).toEqual({ contactId: ALICE, include: 'both' });
    expect((await h.json(STATUS, { nonce: begun.nonce })).json).toEqual({
      status: 'done',
      result: {
        messages: { deleted: 3, notarized: 0, kept: 0 },
        files: { trashed: 2, changed: 0, missing: 0, refused: 0, noTrash: 0, failed: 0 },
      },
    });
  });

  it('the finish takes only the nonce: a selector in it is refused and nothing applies', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'messages' });
    const sneaky = await h.finish(
      { nonce: begun.nonce, contact: BOB, include: 'both' },
      world.code,
    );
    expect(sneaky.status).toBeGreaterThanOrEqual(400);
    await sleep(UNDO_MS * 3);
    expect(h.state.applied).toEqual([]);
    expect(h.state.planned.every((p) => !('contactId' in p) || p.contactId === ALICE)).toBe(true);
  });

  it('Undo within the window applies nothing', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'both' });
    expect((await h.finish({ nonce: begun.nonce }, world.code)).status).toBe(200);
    const undone = await h.json(UNDO, { nonce: begun.nonce });
    expect(undone).toEqual({ status: 200, json: { status: 'cancelled' } });
    await sleep(UNDO_MS * 3);
    expect(h.state.applied).toEqual([]);
    expect((await h.json(STATUS, { nonce: begun.nonce })).json).toEqual({ status: 'cancelled' });
  });

  it('a stale plan (changed since it was shown) is refused at finish', async () => {
    const h = await harness();
    const begun = await h.begin({ contact: ALICE, include: 'both' });
    h.state.hash = 'plan-2';
    const stale = await h.finish({ nonce: begun.nonce }, world.code);
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ status: 'not_applied' });
    await sleep(UNDO_MS * 3);
    expect(h.state.applied).toEqual([]);
  });

  it('MCP cannot reach it: no page session or no CSRF is refused before anything runs', async () => {
    const h = await harness();
    const body = encodeUtf8(JSON.stringify({ contact: ALICE, include: 'both' }));
    const noCookie = await send(h.server.port, BEGIN, {
      method: 'POST',
      headers: { ...h.headers(), Cookie: '' },
      body,
    });
    expect(noCookie.status).toBe(401);
    const headers = h.headers();
    delete headers['X-AgentLink-CSRF'];
    const noCsrf = await send(h.server.port, BEGIN, { method: 'POST', headers, body });
    expect(noCsrf.status).toBe(403);
    expect(h.state.planned).toEqual([]);
  });

  it('the history kind takes no presence header, no query and no operation input', async () => {
    const h = await harness();
    const withPresence = await h.json(
      BEGIN,
      { contact: ALICE, include: 'both' },
      { 'X-AgentLink-Presence': 'passkey' },
    );
    expect(withPresence.status).toBe(400);
    const withInput = await h.json(
      BEGIN,
      { contact: ALICE, include: 'both' },
      { 'X-AgentLink-Input': 'e30' },
    );
    expect(withInput.status).toBe(400);
    expect(h.state.planned).toEqual([]);
  });
});

describe('the route registry (history and inbox-reveal kinds)', () => {
  it('a history route is only its POST at its fixed path, once; finish only at the finish path', () => {
    const r = new LocalUiRouteRegistry();
    const handler = () => Promise.resolve({ status: 200, body: {} });
    expect(() =>
      r.register({
        method: 'POST',
        path: '/api/ui/history/other',
        presence: 'history',
        step: 'begin',
        handler,
      } as never),
    ).toThrow();
    expect(() =>
      r.register({
        method: 'POST',
        path: '/api/ui/rules/x',
        presence: true,
        historyFinish: true,
        handler,
      } as never),
    ).toThrow();
    expect(() =>
      r.register({
        method: 'POST',
        path: '/api/ui/files/x',
        presence: 'inbox-reveal',
        handler,
      } as never),
    ).toThrow();
    r.register({
      method: 'POST',
      path: BEGIN,
      presence: 'history',
      step: 'begin',
      handler,
    } as never);
    expect(() =>
      r.register({
        method: 'POST',
        path: BEGIN,
        presence: 'history',
        step: 'begin',
        handler,
      } as never),
    ).toThrow();
  });
});
