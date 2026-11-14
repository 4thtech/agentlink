// FILES-REVEAL (S2; D-152; 08 §1 "Show in Finder for the folders"; 04 §4 "Pinned at allow time";
// I-4, I-5, I-7): `POST /api/ui/files/send-folder/reveal` shows the open ID's own Send folder in
// Finder / Explorer. It takes NO input (a query, body, presence or input header is refused), sits
// behind the session cookie, CSRF, Origin and fetch-metadata gate, and opens only the ID's own
// allowed, pinned Send folder: a folder that became a link, a file or is missing answers a fixed
// `not_found` and nothing is opened. Answers carry no path; nothing is logged beyond codes. No MCP
// tool can reach it.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { LocalUiAssets } from './context.js';

const REVEAL = '/api/ui/files/send-folder/reveal';
const INBOX_REVEAL = '/api/ui/storage/inbox/reveal';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-files-reveal-');
}, 60_000);
afterAll(() => world.cleanup());

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';
const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([['index.html', encodeUtf8(INDEX_HTML)]]),
});

const servers: ApprovalServer[] = [];
let home = '';
let sendFolder = '';
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'files-reveal-home-')));
  sendFolder = path.join(home, 'AgentLink', 'Send');
  await mkdir(sendFolder, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(home, { recursive: true, force: true });
});

async function harness(
  options: { folders?: string[]; mode?: string; revealed?: boolean; loadFails?: boolean } = {},
) {
  const calls: { file: string; folder: string }[] = [];
  const folders = options.folders ?? ['~/AgentLink/Send'];
  const policy =
    options.mode === 'fail_closed'
      ? { mode: 'fail_closed' }
      : {
          mode: 'signed',
          version: 3,
          policy: { files: { allowedFolders: folders, storage: 'drop', maxSendSizeMB: 25 } },
        };
  const client = {
    agentId: world.agentId,
    ownerActions: {
      loadPolicy: () =>
        options.loadFails === true ? Promise.reject(new Error('boom')) : Promise.resolve(policy),
    },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.resolve({ status: 'refused', op: 'x', reason: 'x' } as never),
  };
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (e) => events.push(e),
      localUi: { assets: bundle(), client: client as never },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      filesHome: home,
      fileRevealer: (file, folder) => {
        calls.push({ file, folder });
        return Promise.resolve(options.revealed ?? true);
      },
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const post = (
    p: string,
    body: Uint8Array = new Uint8Array(0),
    extra: Record<string, string> = {},
    omit: readonly string[] = [],
  ) => {
    const headers: Record<string, string> = {
      Cookie: cookie,
      Origin: server.origin,
      'X-AgentLink-CSRF': csrf,
      'Content-Type': 'application/octet-stream',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Length': String(body.length),
      ...extra,
    };
    for (const name of omit) Reflect.deleteProperty(headers, name);
    return send(server.port, p, { method: 'POST', headers, body });
  };
  return { calls, events, server, post };
}

describe('FILES-REVEAL: the Send folder route', () => {
  it('opens only the ID own pinned Send folder, answers `shown` with no path', async () => {
    const h = await harness();
    const res = await h.post(REVEAL);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'shown' });
    expect(res.body).not.toContain(home);
    expect(h.calls).toEqual([{ file: sendFolder, folder: path.dirname(sendFolder) }]);
  });

  it('takes no input: a body, a query, a presence or an input header is refused, nothing opened', async () => {
    const h = await harness();
    expect((await h.post(REVEAL, encodeUtf8('{"path":"/etc"}'))).status).toBe(400);
    expect((await h.post(`${REVEAL}?path=/etc`)).status).toBe(400);
    expect(
      (await h.post(REVEAL, new Uint8Array(0), { 'X-AgentLink-Presence': 'passkey' })).status,
    ).toBe(400);
    expect((await h.post(REVEAL, new Uint8Array(0), { 'X-AgentLink-Input': 'e30' })).status).toBe(
      400,
    );
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['the session cookie', 'Cookie'],
    ['the CSRF header', 'X-AgentLink-CSRF'],
    ['the Origin header', 'Origin'],
  ])('is refused without %s, nothing opened', async (_label, header) => {
    const h = await harness();
    const res = await h.post(REVEAL, new Uint8Array(0), {}, [header as string]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(h.calls).toEqual([]);
  });

  it('is refused for a foreign Origin and for a cross-site request', async () => {
    const h = await harness();
    const a = await h.post(REVEAL, new Uint8Array(0), { Origin: 'http://evil.example' });
    expect(a.status).toBeGreaterThanOrEqual(400);
    const b = await h.post(REVEAL, new Uint8Array(0), { 'Sec-Fetch-Site': 'cross-site' });
    expect(b.status).toBeGreaterThanOrEqual(400);
    expect(h.calls).toEqual([]);
  });

  it('is a POST only', async () => {
    const h = await harness();
    const res = await send(h.server.port, REVEAL, { method: 'GET' });
    expect(res.status).not.toBe(200);
    expect(h.calls).toEqual([]);
  });

  it('a Send folder that became a link: fixed not_found, never opened', async () => {
    const elsewhere = path.join(home, 'Elsewhere');
    await mkdir(elsewhere);
    await rm(sendFolder, { recursive: true });
    await symlink(elsewhere, sendFolder);
    const h = await harness();
    const res = await h.post(REVEAL);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(h.calls).toEqual([]);
  });

  it('a Send folder that is a file or is missing: fixed not_found, never opened', async () => {
    await rm(sendFolder, { recursive: true });
    await writeFile(sendFolder, 'x');
    const h = await harness();
    expect(JSON.parse((await h.post(REVEAL)).body)).toEqual({ error: 'not_found' });
    await rm(sendFolder);
    expect(JSON.parse((await h.post(REVEAL)).body)).toEqual({ error: 'not_found' });
    expect(h.calls).toEqual([]);
  });

  it('no Send folder allowed, or only another folder allowed: not_found, never opened', async () => {
    await mkdir(path.join(home, 'Other'));
    const none = await harness({ folders: [] });
    expect((await none.post(REVEAL)).status).toBe(404);
    const another = await harness({ folders: ['~/Other'] });
    expect((await another.post(REVEAL)).status).toBe(404);
    expect(none.calls).toEqual([]);
    expect(another.calls).toEqual([]);
  });

  it('under fail-closed or an unreadable policy: unavailable, never opened', async () => {
    const closed = await harness({ mode: 'fail_closed' });
    const a = await closed.post(REVEAL);
    expect(a.status).toBe(503);
    expect(JSON.parse(a.body)).toEqual({ error: 'unavailable' });
    const broken = await harness({ loadFails: true });
    expect((await broken.post(REVEAL)).status).toBe(503);
    expect(closed.calls).toEqual([]);
    expect(broken.calls).toEqual([]);
  });

  it('when the OS could not open it: fixed not_opened, no path', async () => {
    const h = await harness({ revealed: false });
    const res = await h.post(REVEAL);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_opened' });
    expect(res.body).not.toContain(home);
  });

  it('logs nothing beyond codes: no event carries a path', async () => {
    const h = await harness();
    await h.post(REVEAL);
    expect(JSON.stringify(h.events)).not.toContain(home);
  });

  it('the Inbox keeps its own route and never opens the Send folder', async () => {
    const h = await harness();
    const res = await h.post(INBOX_REVEAL);
    // These fake rules have no Inbox folder: a fixed answer, nothing opened.
    expect(res.status).toBe(404);
    expect(h.calls).toEqual([]);
  });
});

describe('FILES-REVEAL: MCP cannot reach it (I-4)', () => {
  it('no MCP tool source names the reveal routes or the revealer', () => {
    const tools = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'mcp-tools',
      'src',
    );
    const names = readdirSync(tools).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      const text = readFileSync(path.join(tools, name), 'utf8');
      expect(text, name).not.toMatch(/send-folder\/reveal|revealSendFolder/);
    }
  });
});
