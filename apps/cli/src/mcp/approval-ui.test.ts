// M1-11a-b: the local approval UI wired into `agentlink mcp` (08 §1; 06 §2.5; 04 §2.5; I-4, I-5).
//
// - `agentlink mcp` starts the local approval server on demand (the first `pending_approval`),
//   reuses it for later ones and closes it with the server, before the agent closes.
// - A `pending_approval` result carries the approval page's `url`, pinned to the local UI origin
//   `http://localhost:<port>`, next to the existing `agentlink approve` command. The url is visible
//   to the agent, so it holds no secret: no session link token. The nextStep and every approval
//   tool's description tell the agent to show it to the user and never open or fetch it itself.
// - The one-shot session link goes only to the OS browser opener, once per request and at most once
//   per BROWSER_OPEN_INTERVAL_MS; the agent never sees it.
// - A same-user agent that fetches the url (with the real server) gets the expired page and cannot
//   approve: every API route needs the session cookie, and a decision needs owner presence on top.
//   The presence and one-shot rules against the real server are in
//   packages/node/src/approval-server.test.ts ("the agent-visible approval url").
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AgentLinkClient,
  CommitmentCard,
  ContactView,
  RespondToTermsResult,
} from '@4thtech-io/core';
import { createLogger } from '@4thtech-io/log';
import {
  startApprovalServer,
  type ApprovalServer,
  type ApprovalServerSource,
} from '@4thtech-io/node';
import type { ContactDisplayName, RestrictedName, Terms } from '@4thtech-io/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliPrefix } from '../runtime/cli-prefix.js';
import type { OpenedAgent } from '../runtime/index.js';
import type { TermsTools } from '../tools/context.js';
import { TOOLS, callTool, type ToolClient, type ToolContext } from '../tools/index.js';
import { acceptRetryStep } from '../tools/invite-common.js';
import { APPROVAL_LINK_NOTE } from '../tools/registry.js';
import {
  BROWSER_OPEN_INTERVAL_MS,
  approvalLinkNextStep,
  createApprovalUi,
  type ApprovalUi,
} from './approval-ui.js';
import { agentToolContext, createMcpCommand } from './command.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const ENVELOPE = 'Q2xhaW1zQ2xhaW1zQ2xhaQ';
const HASH = 'ab'.repeat(32);
const APPROVAL = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const APPROVAL_2 = 'apr_BBBBBBBBBBBBBBBBBBBBBA'; // canonical: 16 bytes
const APPROVAL_3 = 'apr_CCCCCCCCCCCCCCCCCCCCCA';
const VALID_UNTIL = 1_761_206_400;
const silent = createLogger({ sink: () => undefined });
const NEVER_FETCH = /never open or fetch this link/i;

// ---- A fake approval server (the real one is used further down) ---------------------------------

interface FakeServer extends ApprovalServer {
  readonly opened: (string | undefined)[];
  readonly notified: string[];
  readonly closed: { count: number };
}

function fakeServer(origin = 'http://localhost:47321'): FakeServer {
  const opened: (string | undefined)[] = [];
  const notified: string[] = [];
  const closed = { count: 0 };
  const port = Number(new URL(origin).port);
  return {
    origin,
    port,
    opened,
    notified,
    closed,
    address: () => ({ host: 'localhost', port, addresses: ['127.0.0.1'] }),
    approvalUrl: (id) => `${origin}/approve/${id}`,
    open: (id) => {
      opened.push(id);
      return Promise.resolve(true);
    },
    notifyNewApproval: (id) => {
      notified.push(id);
      return Promise.resolve(`${origin}/approve/${id}`);
    },
    close: () => {
      closed.count += 1;
      return Promise.resolve();
    },
  };
}

function ui(server: ApprovalServer, now: () => number = () => 1_000_000) {
  const start = vi.fn(() => Promise.resolve(server));
  const created = createApprovalUi({ start, agentName: 'default', logger: silent, nowMs: now });
  return { ui: created, start };
}

describe('the approval UI starts on demand and stops cleanly', () => {
  it('starts no server until a link is asked for, then reuses one', async () => {
    const server = fakeServer();
    const { ui: approvalUi, start } = ui(server);
    expect(start).not.toHaveBeenCalled();
    expect(approvalUi.running).toBe(false);
    const [one, two] = await Promise.all([approvalUi.link(APPROVAL), approvalUi.link(APPROVAL_2)]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(approvalUi.running).toBe(true);
    expect(one?.url).toBe(`http://localhost:47321/approve/${APPROVAL}`);
    expect(two?.url).toBe(`http://localhost:47321/approve/${APPROVAL_2}`);
    await approvalUi.close();
    expect(server.closed.count).toBe(1);
    expect(approvalUi.running).toBe(false);
  });

  it('after close, gives no link and starts nothing', async () => {
    const server = fakeServer();
    const { ui: approvalUi, start } = ui(server);
    await approvalUi.close();
    expect(await approvalUi.link(APPROVAL)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(server.closed.count).toBe(0);
  });

  it('closes a server whose start finishes after close', async () => {
    const server = fakeServer();
    let finish: (s: ApprovalServer) => void = () => undefined;
    const start = vi.fn(
      () =>
        new Promise<ApprovalServer>((resolve) => {
          finish = resolve;
        }),
    );
    const approvalUi = createApprovalUi({ start, agentName: 'default', logger: silent });
    const pending = approvalUi.link(APPROVAL);
    const closing = approvalUi.close();
    finish(server);
    expect(await pending).toBeUndefined();
    await closing;
    expect(server.closed.count).toBe(1);
  });

  it('falls back to no link when the server cannot start, and tries again later', async () => {
    const server = fakeServer();
    const start = vi
      .fn<() => Promise<ApprovalServer>>()
      .mockRejectedValueOnce(Object.assign(new Error('listen EADDRINUSE secret-ish'), {}))
      .mockResolvedValue(server);
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (_l, line) => lines.push(line) });
    const approvalUi = createApprovalUi({ start, agentName: 'default', logger });
    expect(await approvalUi.link(APPROVAL)).toBeUndefined();
    expect(lines.join('\n')).not.toContain('secret-ish');
    expect((await approvalUi.link(APPROVAL))?.url).toContain('/approve/');
    await approvalUi.close();
  });

  it('refuses an ID that is not an approval ID without starting the server', async () => {
    const server = fakeServer();
    const { ui: approvalUi, start } = ui(server);
    for (const bad of ['apr_x', `${APPROVAL}/../x`, '', 'apr_AAAAAAAAAAAAAAAAAAAAA?']) {
      expect(await approvalUi.link(bad)).toBeUndefined();
    }
    expect(start).not.toHaveBeenCalled();
  });
});

describe('the url is pinned to the local UI origin and holds no secret', () => {
  it('is exactly <origin>/approve/<id>, with no query', async () => {
    const { ui: approvalUi } = ui(fakeServer());
    const link = await approvalUi.link(APPROVAL);
    expect(link).toBeDefined();
    expect(link?.origin).toBe('http://localhost:47321');
    expect(link?.url).toBe(`http://localhost:47321/approve/${APPROVAL}`);
    expect(new URL(link?.url ?? '').search).toBe('');
    await approvalUi.close();
  });

  it.each([
    'http://127.0.0.1:47321',
    'http://[::1]:47321',
    'https://localhost:47321',
    'http://localhost',
    'http://evil.example:47321',
  ])('gives no link when the server origin is %s', async (origin) => {
    const server = { ...fakeServer(), origin };
    const { ui: approvalUi } = ui(server);
    expect(await approvalUi.link(APPROVAL)).toBeUndefined();
    await approvalUi.close();
  });

  it('gives no link when the server returns a url carrying a token', async () => {
    const server = {
      ...fakeServer(),
      approvalUrl: (id: string) => `http://localhost:47321/approve/${id}?t=leak`,
    };
    const { ui: approvalUi } = ui(server);
    expect(await approvalUi.link(APPROVAL)).toBeUndefined();
    await approvalUi.close();
  });
});

describe('the owner’s browser opens with the one-shot link, not the agent', () => {
  it('alerts at most once per interval across requests, coalescing the rest (L-3)', async () => {
    let now = 1_000_000;
    const server = fakeServer();
    const { ui: approvalUi } = ui(server, () => now);
    expect((await approvalUi.link(APPROVAL))?.url).toContain(APPROVAL);
    await approvalUi.link(APPROVAL); // the agent asks again: no second window
    expect(server.opened).toEqual([APPROVAL]);
    // Within the interval: no window and no notification; the open page lists it. The link works
    // in the browser that was opened.
    expect((await approvalUi.link(APPROVAL_2))?.url).toContain(APPROVAL_2);
    expect(server.opened).toEqual([APPROVAL]);
    expect(server.notified).toEqual([]);
    now += BROWSER_OPEN_INTERVAL_MS;
    await approvalUi.link(APPROVAL_2); // already counted: nothing more
    expect(server.opened).toEqual([APPROVAL]);
    await approvalUi.link(APPROVAL_3); // a new request after the interval: one new window
    expect(server.opened).toEqual([APPROVAL, APPROVAL_3]);
    expect(server.notified).toEqual([]);
    await approvalUi.close();
  });

  it('with no browser, gives no link (CLI only) and notifies at most once per interval (L-2, L-3)', async () => {
    let now = 1_000_000;
    const server = { ...fakeServer(), opened: [] as (string | undefined)[] };
    const notified: string[] = [];
    const noBrowser: ApprovalServer = {
      ...server,
      open: (id) => {
        server.opened.push(id);
        return Promise.resolve(false);
      },
      notifyNewApproval: (id) => {
        notified.push(id);
        return Promise.resolve('');
      },
    };
    const { ui: approvalUi } = ui(noBrowser, () => now);
    expect(await approvalUi.link(APPROVAL)).toBeUndefined();
    expect(notified).toEqual([APPROVAL]);
    expect(await approvalUi.link(APPROVAL_2)).toBeUndefined();
    expect(notified).toEqual([APPROVAL]);
    now += BROWSER_OPEN_INTERVAL_MS;
    expect(await approvalUi.link(APPROVAL_3)).toBeUndefined();
    // The opener is not tried again; the owner gets one notification per interval.
    expect(server.opened).toEqual([APPROVAL]);
    expect(notified).toEqual([APPROVAL, APPROVAL_3]);
    await approvalUi.close();
  });
});

describe('the link nextStep command prefix (M1-36a)', () => {
  it('prints the npx form when given it, never a bare name that is not on PATH', () => {
    const url = `http://localhost:47321/approve/${APPROVAL}`;
    const npx = 'npx -y @4thtech-io/agentlink';
    expect(approvalLinkNextStep(APPROVAL, url, 'work', npx)).toContain(
      `\`${npx} approve ${APPROVAL} --agent work\``,
    );
  });
});

describe('the nextStep with the link (06 §2.5; 11 §6.10)', () => {
  it('names the link, keeps the CLI command and tells the agent never to open or fetch it', () => {
    const url = `http://localhost:47321/approve/${APPROVAL}`;
    const text = approvalLinkNextStep(APPROVAL, url, 'default');
    expect(text).toContain(url);
    expect(text).toContain(`${cliPrefix()} approve ${APPROVAL}`);
    expect(text).toMatch(NEVER_FETCH);
    expect(text).toContain("Your AI can't approve this for you.");
    expect(text).toContain('call the same tool again with approvalId');
    expect(approvalLinkNextStep(APPROVAL, url, 'work')).toContain(
      `${cliPrefix()} approve ${APPROVAL} --agent work`,
    );
    for (const word of [/\bwallet/i, /\bgas\b/i, /seed phrase/i, /transaction/i]) {
      expect(text).not.toMatch(word);
    }
  });

  it('leaves room for a tool sentence after it (the accept retry) within the 500-character limit', () => {
    const url = `http://localhost:65535/approve/${APPROVAL}`;
    for (const name of ['default', 'work-laptop-agent']) {
      const text = `${approvalLinkNextStep(APPROVAL, url, name)} ${acceptRetryStep(APPROVAL)}`;
      expect(Array.from(text).length, name).toBeLessThanOrEqual(500);
    }
  });

  it('every tool that can return pending_approval says so in its description', () => {
    expect(APPROVAL_LINK_NOTE).toMatch(NEVER_FETCH);
    for (const tool of TOOLS) {
      if (tool.approval) expect(tool.description, tool.name).toContain(APPROVAL_LINK_NOTE);
      else expect(tool.description, tool.name).not.toContain(APPROVAL_LINK_NOTE);
    }
  });
});

// ---- pending_approval through the tool layer ---------------------------------------------------

const display = (name: string): ContactDisplayName =>
  ({
    name: name as RestrictedName,
    label: 'self-declared',
    nameSource: 'counterparty',
  }) as ContactDisplayName;

const card = (): CommitmentCard =>
  ({
    decision: 'accept',
    counterparty: { agentId: B, display: display('Marko'), shown: '“Marko” (self-declared)' },
    version: 3,
    terms: { termsId: ENVELOPE, version: 3 } as unknown as Terms,
    changes: null,
    parts: ['accept_envelope', 'accepted_receipt'],
    autoAccept: 'contact_not_listed',
    lateAccept: null,
    validUntil: VALID_UNTIL,
    expiresAt: VALID_UNTIL,
    fee: null,
    fingerprint: HASH,
  }) as CommitmentCard;

function pendingClient(approvalId = APPROVAL): ToolClient {
  const reject = () => Promise.reject(new Error('not used'));
  const terms: TermsTools = {
    propose: reject,
    respond: () =>
      Promise.resolve({
        status: 'pending_approval',
        approvalId,
        actionDigest: HASH,
        summary: 'core text',
        expiresAt: VALID_UNTIL,
        card: card(),
      } as RespondToTermsResult),
    senderOf: () => Promise.resolve({ id: B, display: display('Marko') }),
  };
  return {
    self: () =>
      Promise.resolve({ agentId: A, agentFingerprint: '1111·2222', ownerFingerprint: '3333·4444' }),
    catchUp: reject,
    storedCounts: reject,
    storageMode: reject,
    pendingApprovals: reject,
    approvalState: reject,
    syncInbox: reject,
    inboxPage: reject,
    send: reject,
    contacts: () => Promise.resolve([] as ContactView[]),
    terms,
  } as unknown as ToolClient;
}

function contextWith(approvalUi: ApprovalUi | undefined, client = pendingClient()): ToolContext {
  const agent = { name: 'default', client: {} as AgentLinkClient } as unknown as OpenedAgent;
  return { ...agentToolContext(agent, silent, () => 1_760_600_000, approvalUi), client };
}

const respond = (context: ToolContext) =>
  callTool('agentlink_respond_to_terms', { envelopeId: ENVELOPE, decision: 'accept' }, context);

describe('pending_approval carries the approval url (M1-11a-b)', () => {
  it('adds the url and the link nextStep, keeping the CLI command', async () => {
    const { ui: approvalUi } = ui(fakeServer());
    const result = await respond(contextWith(approvalUi));
    expect(result.structured.status).toBe('pending_approval');
    expect(result.structured.approvalId).toBe(APPROVAL);
    expect(result.structured.url).toBe(`http://localhost:47321/approve/${APPROVAL}`);
    expect(result.structured.nextStep).toContain(`http://localhost:47321/approve/${APPROVAL}`);
    expect(result.structured.nextStep).toContain(`${cliPrefix()} approve ${APPROVAL}`);
    expect(result.structured.nextStep).toMatch(NEVER_FETCH);
    expect(result.text).toContain(result.structured.url as string);
    expect(result.text).toMatch(NEVER_FETCH);
    await approvalUi.close();
  });

  it('without the approval UI the result is the M1a one: no url, CLI command only', async () => {
    const result = await respond(contextWith(undefined));
    expect(result.structured.status).toBe('pending_approval');
    expect(result.structured.url).toBeUndefined();
    expect(result.structured.nextStep).toContain(`${cliPrefix()} approve ${APPROVAL}`);
  });

  it('a link outside the local UI origin never reaches the result (origin pin)', async () => {
    const context: ToolContext = {
      ...contextWith(undefined),
      approvalLink: (id) =>
        Promise.resolve({
          url: `https://evil.example/approve/${id}`,
          origin: 'http://localhost:47321',
          nextStep: approvalLinkNextStep(id, `https://evil.example/approve/${id}`, 'default'),
        }),
    };
    const result = await respond(context);
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(result.structured.status).toBe('pending_approval');
    expect(result.structured.nextStep).toContain(`${cliPrefix()} approve ${APPROVAL}`);
  });

  it('a failing link provider leaves the M1a result', async () => {
    const context: ToolContext = {
      ...contextWith(undefined),
      approvalLink: () => Promise.reject(new Error('boom secret')),
    };
    const result = await respond(context);
    expect(result.structured.status).toBe('pending_approval');
    expect(result.structured.url).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

// ---- Against the real approval server: the agent holds only the url ------------------------------

const source: ApprovalServerSource & { applied: number } = {
  applied: 0,
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => {
    source.applied += 1;
    return Promise.reject(new Error('must not be reached'));
  },
};

const realServers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(realServers.splice(0).map((s) => s.close()));
});

describe('a same-user agent that fetches the url cannot approve (I-4, 04 §2.5)', () => {
  it('gets the expired page and no session; every decision route refuses it', async () => {
    const opened: (string | undefined)[] = [];
    const start = async (): Promise<ApprovalServer> => {
      const real = await startApprovalServer({ source });
      realServers.push(real);
      // The OS opener is replaced: the test never launches a browser. The link it would get is
      // never visible to the agent anyway.
      return {
        ...real,
        address: () => real.address(),
        approvalUrl: (id) => real.approvalUrl(id),
        notifyNewApproval: () => Promise.resolve(''),
        close: () => real.close(),
        open: (id) => {
          opened.push(id);
          return Promise.resolve(true);
        },
      };
    };
    const approvalUi = createApprovalUi({ start, agentName: 'default', logger: silent });
    const result = await respond(contextWith(approvalUi));
    const url = result.structured.url as string;
    expect(url).toMatch(/^http:\/\/localhost:[0-9]+\/approve\/apr_A{22}$/);
    expect(opened).toEqual([APPROVAL]);

    // What an agent with shell access does with the url: curl it, follow it, post to the API.
    const page = await fetch(url, { redirect: 'manual' });
    expect(page.status).toBe(401);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(await page.text()).toContain('This link has expired');

    const origin = new URL(url).origin;
    for (const [path, init] of [
      ['/api/approvals', {}],
      [`/api/approvals/${APPROVAL}`, {}],
      [
        `/api/approvals/${APPROVAL}/approve`,
        {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
          body: 'AAAA BBBB CCCC DDDD EEEE FFFF',
        },
      ],
      [
        '/api/approvals/review',
        {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/octet-stream',
            'X-AgentLink-Items': `${APPROVAL}:${HASH}:a`,
          },
          body: 'AAAA BBBB CCCC DDDD EEEE FFFF',
        },
      ],
    ] as const) {
      const res = await fetch(`${origin}${path}`, { ...init, redirect: 'manual' });
      expect(res.status, path).toBe(401);
    }
    // A token guessed into the url is refused too (one-shot links are 256-bit and never shown).
    const guessed = await fetch(`${url}?t=${'A'.repeat(43)}`, { redirect: 'manual' });
    expect(guessed.status).toBe(401);
    expect(source.applied).toBe(0);
    await approvalUi.close();
  });
});

// ---- `agentlink mcp` lifecycle ---------------------------------------------------------------------

describe('agentlink mcp starts and stops the approval UI with the server', () => {
  const parsed = { values: {}, positionals: [], agent: undefined };
  const io = {
    output: { print: vi.fn(), printError: vi.fn() },
    terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
  };

  it('builds the UI for the opened agent, starts nothing up front and closes it before the agent', async () => {
    const order: string[] = [];
    const coreClient = {
      identity: { get: () => Promise.resolve(undefined) },
      publisherLease: () => ({
        held: false,
        take: () => Promise.resolve(false),
        renew: () => Promise.resolve(false),
        release: () => Promise.resolve(false),
      }),
      inbox: { counts: () => Promise.resolve({ inbox: [], requests: 0 }) },
    } as unknown as AgentLinkClient;
    const agent = {
      name: 'default',
      agentId: A,
      client: coreClient,
      close: () => {
        order.push('agent closed');
        return Promise.resolve();
      },
    } as unknown as OpenedAgent;
    const server = fakeServer();
    const start = vi.fn(() => Promise.resolve(server));
    const factory = vi.fn((opened: OpenedAgent) => {
      expect(opened).toBe(agent);
      const created = createApprovalUi({ start, agentName: opened.name, logger: silent });
      return {
        link: created.link,
        get running() {
          return created.running;
        },
        close: async () => {
          await created.close();
          order.push('ui closed');
        },
      } satisfies ApprovalUi;
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const command = createMcpCommand({
      openAgent: () => Promise.resolve({ status: 'ok', agent }),
      transport: () => serverSide,
      version: '0',
      logger: silent,
      approvalUi: factory,
    });
    const running = command({ command: 'mcp', parsed, ...io });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    await client.listTools();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    await client.close();
    await expect(running).resolves.toBe(0);
    expect(order).toEqual(['ui closed', 'agent closed']);
  });

  it('builds no UI when the agent is not set up', async () => {
    const factory = vi.fn();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const command = createMcpCommand({
      openAgent: () =>
        Promise.resolve({ status: 'needs_setup', reason: 'no_agent', message: 'Set up first.' }),
      transport: () => serverSide,
      version: '0',
      logger: silent,
      approvalUi: factory,
    });
    const running = command({ command: 'mcp', parsed, ...io });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    await client.close();
    await expect(running).resolves.toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });
});
