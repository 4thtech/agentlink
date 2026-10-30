// W4-PAUSE fix round (U5 real-app journey): Resume end to end through the approval server's real
// owner-presence gate and owner-action allowlist (owner-allowlist.ts), with the real owner store and
// owner code. Core is a small fake that prepares `agent.resume` exactly as core does
// (buildOwnerActionBody) and checks the owner signature on apply. Without `agent.resume` in the
// allowlist the gate refuses before signing and the route answers `not_applied`.
import {
  buildOwnerActionBody,
  newOwnerActionNonce,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import { encodeHex, encodeUtf8, type JsonObject } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import { AGENTS_RESUME_PATH } from './routes.js';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-w4-resume-');
});
afterAll(() => {
  world.cleanup();
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function harness() {
  const state = { paused: true, applied: [] as JsonObject[] };
  const client = {
    agentId: world.agentId,
    ownerActions: {
      loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
      prepareResume: () => {
        if (!state.paused) {
          return Promise.resolve({ status: 'refused', op: 'agent.resume', reason: 'not_paused' });
        }
        const issuedAt = Math.floor(Date.now() / 1000);
        const { body, jcs } = buildOwnerActionBody({
          agent: world.agentId,
          owner: encodeHex(world.owner.ownerNostr),
          op: 'agent.resume',
          params: { agent: world.agentId },
          nonce: newOwnerActionNonce(),
          issuedAt,
          expiresAt: issuedAt + 600,
        });
        return Promise.resolve({ status: 'prepared', op: 'agent.resume', body, jcs });
      },
    },
    pause: {
      read: () =>
        Promise.resolve(
          state.paused ? { status: 'paused', pausedAt: 1_800_000_000 } : { status: 'running' },
        ),
    },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: (signed) => {
      const body = signed.body as JsonObject;
      if (body['op'] !== 'agent.resume' || !ownerSigValid(world.owner, body, signed.sig)) {
        return Promise.resolve({ status: 'refused', op: 'agent.resume', reason: 'x' } as never);
      }
      state.applied.push(body);
      state.paused = false;
      return Promise.resolve({ status: 'applied', op: 'agent.resume' } as OwnerActionOutcome);
    },
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
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const resume = (code: string) =>
    send(server.port, AGENTS_RESUME_PATH, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        'X-AgentLink-Input': 'e30', // base64url of `{}`
      },
      body: encodeUtf8(code),
    });
  return { state, resume };
}

describe('Resume end to end through the real owner gate and allowlist (W4-PAUSE)', () => {
  it('with the owner code: one agent.resume signed by the owner key, applied, resumed', async () => {
    const h = await harness();
    const res = await h.resume(world.code);
    expect(JSON.parse(res.body)).toEqual({ status: 'resumed' });
    expect(res.status).toBe(200);
    expect(h.state.applied).toHaveLength(1);
    expect(h.state.applied[0]).toMatchObject({
      op: 'agent.resume',
      agent: world.agentId,
      params: { agent: world.agentId },
    });
    expect(h.state.paused).toBe(false);
  });

  it('a wrong owner code signs nothing and the agent stays paused', async () => {
    const h = await harness();
    const res = await h.resume('AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(res.status).toBe(403);
    expect(h.state.applied).toEqual([]);
    expect(h.state.paused).toBe(true);
  });

  it('not paused: not_paused before the gesture, nothing signed', async () => {
    const h = await harness();
    h.state.paused = false;
    const res = await h.resume(world.code);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_paused' });
    expect(h.state.applied).toEqual([]);
  });
});
