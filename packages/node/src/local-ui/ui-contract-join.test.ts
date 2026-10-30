// U3-invite CONTRACT, server side: the REAL app host, gates and route handlers against the shared
// join-screen samples (@4thtech-io/types/ui-contract/join). Each sample request goes in exactly as
// the page sends it; the real answer must be the sample answer. The page side
// (apps/local-ui/src/pages/join/contract.test.ts) asserts the client builds the same requests and
// reads the same answers.
//
// - The read, "Not now" and a changed inviteId go through the real approval server as the app host
//   (session cookie, CSRF, Origin, octet-stream, X-AgentLink-Generation, X-AgentLink-Input).
// - A started accept goes through the real handler of api/join.ts, fed what the presence gate hands
//   it (the JSON of X-AgentLink-Input and a one-use sign); the context is a small fake.
import { CoreError } from '@4thtech-io/core';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import {
  JOIN_ACCEPT,
  JOIN_ACCEPT_PATH as SAMPLE_ACCEPT_PATH,
  JOIN_DISMISS,
  JOIN_DISMISS_PATH as SAMPLE_DISMISS_PATH,
  JOIN_HANDOFF_PATH as SAMPLE_HANDOFF_PATH,
  JOIN_PAGE_PATH as SAMPLE_PAGE_PATH,
  JOIN_PATH as SAMPLE_PATH,
  JOIN_READ,
  JOIN_WORLD,
  OCTET_STREAM,
} from '@4thtech-io/types/ui-contract/join';
import { afterEach, describe, expect, it } from 'vitest';
import { startApprovalServerWith, type ApprovalServer } from '../approval-server.js';
import type { AgentDirectory, AppHostAgent } from './app-host.js';
import type { LocalUiContext } from './context.js';
import {
  JOIN_ACCEPT_PATH,
  JOIN_DISMISS_PATH,
  JOIN_HANDOFF_PATH,
  JOIN_PAGE_PATH,
  JOIN_PATH,
} from './invite-paths.js';
import { JoinDesk, type JoinCheck } from './join-desk.js';
import type { LocalUiOwnerOperation, LocalUiOwnerRoute } from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const LINK = `https://agentlink.4thtech.io/i#${'A'.repeat(64)}`;
const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';

const contact = {
  id: JOIN_WORLD.contactId,
  display: { name: JOIN_WORLD.inviter.name, label: 'self-declared', nameSource: 'counterparty' },
  ownerFingerprint: { short: JOIN_WORLD.inviter.fingerprint, long: 'AB'.repeat(32) },
  pairing: 'pending',
  safetyCodeChecked: false,
};

/** Accept step 1 as core answers it for the world's invite. */
const check: JoinCheck = (link, nowSeconds) =>
  link !== LINK
    ? Promise.reject(new CoreError('invite_invalid', 'x'))
    : JOIN_WORLD.expiresAtSeconds <= nowSeconds
      ? Promise.reject(new CoreError('invite_expired', 'x'))
      : Promise.resolve({
          inviteId: JOIN_WORLD.inviteId,
          contact: contact as never,
          expiresAt: JOIN_WORLD.expiresAtSeconds,
        });

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function host(waiting: boolean) {
  const client = {
    agentId: JOIN_WORLD.agentId,
    contacts: { list: () => Promise.resolve([]) },
    ownerActions: { loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }) },
  };
  const agent: AppHostAgent = {
    name: 'default',
    label: 'Personal',
    source: {
      context: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      apply: () => Promise.reject(new Error('never')),
    },
    localUi: { client: client as never },
    close: () => Promise.resolve(),
  };
  const entry = { name: 'default', label: 'Personal', available: true, removing: false };
  const directory: AgentDirectory = {
    list: () => Promise.resolve([entry]),
    read: () => Promise.resolve(entry),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: () => Promise.resolve(),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source: agent.source,
      localUi: {
        assets: { files: new Map([['index.html', encodeUtf8(INDEX_HTML)]]) },
        client: client as never,
      },
      host: {
        directory,
        initial: agent,
        open: () => Promise.resolve(agent),
        ...(waiting ? { waitingInvite: LINK } : {}),
      },
    },
    {
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      openOwnerStore: () => Promise.reject(new Error('no owner store')),
      now: () => JOIN_WORLD.nowMs,
      checkInvite: check,
    },
  );
  servers.push(server);
  await server.open();
  const link = new URL(opened[0] ?? '');
  const entryRes = await fetch(`${server.origin}/?t=${link.searchParams.get('t') ?? ''}`, {
    redirect: 'manual',
  });
  const cookie = (entryRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await (await fetch(`${server.origin}/`, { headers: { Cookie: cookie } })).text();
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page)?.[1] ?? '';
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    headers.set('Origin', server.origin);
    headers.set('X-AgentLink-CSRF', csrf);
    const res = await fetch(`${server.origin}${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { send };
}

describe('contract (server): the paths are the samples', () => {
  it('node and the shared samples name the same paths', () => {
    expect([
      JOIN_PATH,
      JOIN_ACCEPT_PATH,
      JOIN_DISMISS_PATH,
      JOIN_HANDOFF_PATH,
      JOIN_PAGE_PATH,
    ]).toEqual([
      SAMPLE_PATH,
      SAMPLE_ACCEPT_PATH,
      SAMPLE_DISMISS_PATH,
      SAMPLE_HANDOFF_PATH,
      SAMPLE_PAGE_PATH,
    ]);
  });
});

describe('contract (server): the real app host answers the join samples', () => {
  it('GET /api/ui/join: none, then the waiting invite', async () => {
    expect(await (await host(false)).send(SAMPLE_PATH)).toEqual(JOIN_READ.none.answer);
    expect(await (await host(true)).send(SAMPLE_PATH)).toEqual(JOIN_READ.waiting.answer);
  });

  it('"Not now": octet-stream {} with the generation header', async () => {
    const { send } = await host(true);
    const answer = await send(SAMPLE_DISMISS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': OCTET_STREAM,
        'X-AgentLink-Generation': String(JOIN_WORLD.generation),
      },
      body: JSON.stringify(JOIN_DISMISS.body),
    });
    expect(answer).toEqual(JOIN_DISMISS.answer);
    expect(await send(SAMPLE_PATH)).toEqual(JOIN_READ.none.answer);
  });

  it('accept with another inviteId: invite_changed before presence (input in X-AgentLink-Input)', async () => {
    const { send } = await host(true);
    const answer = await send(SAMPLE_ACCEPT_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': OCTET_STREAM,
        'X-AgentLink-Generation': String(JOIN_WORLD.generation),
        'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify(JOIN_ACCEPT.changed.input))),
      },
      body: 'presence',
    });
    expect(answer).toEqual(JOIN_ACCEPT.changed.answer);
  });
});

describe('contract (server): the real accept handler answers the started sample', () => {
  it('takes exactly {inviteId} and answers pending with who it is', async () => {
    const desk = new JoinDesk(() => JOIN_WORLD.nowMs, check);
    expect(await desk.offer(LINK)).toBe('stored');
    const context = {
      join: desk,
      client: { agentId: JOIN_WORLD.agentId, contacts: { list: () => Promise.resolve([]) } },
      invites: {
        resolve: (link: string) => Promise.resolve(link),
        list: () => Promise.resolve([]),
        check: () => Promise.resolve(contact),
        decision: () => Promise.resolve('approval'),
        action: () =>
          Promise.resolve({
            tool: 'agentlink_accept_invite',
            args: { inviteUrl: LINK },
            context: {
              triggers: ['contacts.acceptInvites'],
              inviteId: JOIN_WORLD.inviteId,
              counterparty: { agentId: JOIN_WORLD.contactId, ownerKey: 'cd'.repeat(32) },
            },
          }),
        openRequest: () =>
          Promise.resolve({ approvalId: `apr_${'Q'.repeat(22)}`, expiresAt: 1_790_003_600 }),
        acceptApproved: () => Promise.resolve({ status: 'started', contact, sent: true }),
      },
      ownerContext: () =>
        Promise.resolve({
          agent: JOIN_WORLD.agentId,
          owner: {
            ownerEvm: new Uint8Array(20).fill(0x2b),
            ownerNostr: new Uint8Array(32).fill(0xc3),
            ownerEnc: new Uint8Array(32).fill(0x0f),
          },
        }),
      applyOwnerAction: () => Promise.resolve({ status: 'applied', op: 'approval.decide' }),
      now: () => JOIN_WORLD.nowMs,
    } as unknown as LocalUiContext;
    const owner = {
      sign: (_r: unknown, reqs: readonly { kind: string; action?: unknown }[]) =>
        Promise.resolve(
          reqs.map((r) => ({
            kind: 'owner-action',
            signed: { body: r.action, sig: 'ab'.repeat(64) },
          })),
        ),
    } as unknown as LocalUiOwnerOperation;
    const route = createLocalUiRoutes()
      .routes()
      .find((r) => r.path === SAMPLE_ACCEPT_PATH) as LocalUiOwnerRoute;
    const result = await route.handler(
      context,
      {
        params: {},
        query: new URLSearchParams(),
        input: JSON.parse(JSON.stringify(JOIN_ACCEPT.started.input)) as never,
      },
      owner,
    );
    expect({
      status: result.status,
      body: JSON.parse(JSON.stringify(result.body)) as unknown,
    }).toEqual(JOIN_ACCEPT.started.answer);
  });
});
