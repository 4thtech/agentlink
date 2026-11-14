// ATT-APP-ATTACH acceptance: the owner attaches a light text file in the app's conversation and it is
// sent to that person (08 §1 "Attach a file"; 04 §4; D-121 D6; I-4, I-5, I-7).
//
// - `POST /api/ui/attach` (the attach kind) runs only behind the session cookie, the CSRF header,
//   the page's Origin, same-origin fetch metadata and an octet-stream body; no query, operation
//   input or presence header. It is not an MCP tool and the MCP side cannot name it.
// - The body: `{to, text, files: [{name, data}]}` (base64). Each file: allowlisted type (.md,
//   .markdown, .txt, .json), at most 8 MiB, valid UTF-8 without NUL; the name sanitised.
// - The file is written into the ID's allowed Send folder (no overwrite, no link followed), then
//   sent through core's ordinary send with the type from its name (text/markdown for .md).
// - No Send folder allowed: 409 `no_folder` (the page shows Home's Send folder banner).
// - No path and no file name in any event, console line or error answer.
import { readFileSync, readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OwnerActionOutcome } from '@4thtech-io/core';
import { encodeBase64url, encodeUtf8 } from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { LocalUiAssets } from './context.js';
import { ATTACH_MAX_BODY_BYTES, ATTACH_PATH } from './api/attach.js';

const hex = (n: number, pair: string): string => pair.repeat(n);
const CONTACT_ID = `0x${hex(20, '1a')}`;
const PENDING_ID = `0x${hex(20, '2b')}`;
const SECRET_NAME = 'Quarterly-Plan-Secret';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-att-app-');
}, 60_000);
afterAll(() => world.cleanup());

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';
const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([['index.html', encodeUtf8(INDEX_HTML)]]),
});

interface SentCall {
  readonly to: string;
  readonly text: string | undefined;
  readonly clientRequestId: string | undefined;
  readonly files: { realpath: string; name: string; mime: string; size: number; bytes: string }[];
}

const servers: ApprovalServer[] = [];
let home = '';
let sendFolder = '';
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'att-app-home-')));
  sendFolder = path.join(home, 'AgentLink', 'Send');
  await mkdir(sendFolder, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(home, { recursive: true, force: true });
});

interface Harness {
  readonly sent: SentCall[];
  readonly events: ApprovalServerEvent[];
  readonly origin: string;
  readonly port: number;
  post(
    path: string,
    body: Uint8Array | undefined,
    extra?: Record<string, string>,
    omit?: readonly string[],
  ): Promise<{ status: number; body: string }>;
}

async function harness(
  options: { folders?: string[]; result?: unknown; gate?: Promise<void> } = {},
): Promise<Harness> {
  const sent: SentCall[] = [];
  const folders = options.folders ?? ['~/AgentLink/Send'];
  const policy = {
    mode: 'signed',
    version: 3,
    policy: { files: { allowedFolders: folders, storage: 'drop', maxSendSizeMB: 25 } },
  };
  const client = {
    agentId: world.agentId,
    ownerActions: { loadPolicy: () => Promise.resolve(policy) },
    contacts: {
      list: () =>
        Promise.resolve([
          { id: CONTACT_ID, status: 'active', pairing: 'complete' },
          { id: PENDING_ID, status: 'active', pairing: 'pending' },
        ]),
    },
    sendMessage: async (input: {
      to: string;
      text?: string;
      clientRequestId?: string;
      files?: readonly {
        realpath: string;
        name?: string;
        mime?: string;
        size: number;
        open(): Promise<Uint8Array | ReadableStream<Uint8Array>>;
      }[];
    }) => {
      const files = [];
      for (const f of input.files ?? []) {
        const opened = await f.open();
        const bytes =
          opened instanceof Uint8Array
            ? opened
            : new Uint8Array(await new Response(opened).arrayBuffer());
        files.push({
          realpath: f.realpath,
          name: f.name ?? path.basename(f.realpath),
          mime: f.mime ?? 'unset',
          size: f.size,
          bytes: new TextDecoder().decode(bytes),
        });
      }
      if (options.gate !== undefined) await options.gate;
      sent.push({ to: input.to, text: input.text, clientRequestId: input.clientRequestId, files });
      return (
        options.result ?? {
          status: 'ok',
          envelopeId: 'env1',
          thread: 't1',
          sentAt: '2026-11-13T10:00:00Z',
          delivery: 'sent',
          files: files.map((_, index) => ({ index, delivery: 'inline', expiresAt: null })),
        }
      );
    },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: (signed) =>
      Promise.resolve(
        (ownerSigValid(world.owner, signed.body, signed.sig)
          ? { status: 'applied', op: 'x' }
          : { status: 'refused', op: 'x', reason: 'sig' }) as unknown as OwnerActionOutcome,
      ),
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
    sent,
    events,
    origin: server.origin,
    port,
    post: (p, body, extra = {}, omit = []) => {
      const headers: Record<string, string> = {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        // As a browser's fetch does for a byte body (the gate refuses a body of unknown length).
        ...(body === undefined ? {} : { 'Content-Length': String(body.length) }),
        ...extra,
      };
      for (const name of omit) Reflect.deleteProperty(headers, name);
      return send(port, p, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body }),
      }) as never;
    },
  };
}

const b64 = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? encodeUtf8(bytes) : bytes).toString('base64');
const body = (value: unknown): Uint8Array => encodeUtf8(JSON.stringify(value));
const one = (name: string, data: Uint8Array | string, extra: Record<string, unknown> = {}) =>
  body({ to: CONTACT_ID, text: 'Here it is', files: [{ name, data: b64(data) }], ...extra });

describe('ATT-APP-ATTACH: the attach route', () => {
  it('sends a Markdown file: written to the Send folder, sent as text/markdown with the note', async () => {
    const h = await harness();
    const res = await h.post(ATTACH_PATH, one(`${SECRET_NAME}.md`, '# Plan\n\nšđž\n'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'sent' });
    expect(h.sent).toHaveLength(1);
    const call = h.sent[0] as SentCall;
    expect(call.to).toBe(CONTACT_ID);
    expect(call.text).toBe('Here it is');
    expect(call.files).toHaveLength(1);
    const f = call.files[0];
    expect(f?.mime).toBe('text/markdown');
    expect(f?.name).toBe(`${SECRET_NAME}.md`);
    expect(f?.bytes).toBe('# Plan\n\nšđž\n');
    expect(path.dirname(f?.realpath ?? '')).toBe(sendFolder);
    expect(await readFile(path.join(sendFolder, `${SECRET_NAME}.md`), 'utf8')).toBe(
      '# Plan\n\nšđž\n',
    );
  });

  it('sends .txt and .json with their own types, several files in one message', async () => {
    const h = await harness();
    const res = await h.post(
      ATTACH_PATH,
      body({
        to: CONTACT_ID,
        text: '',
        files: [
          { name: 'a.txt', data: b64('plain') },
          { name: 'b.json', data: b64('{"a":1}') },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(h.sent[0]?.files.map((f) => f.mime)).toEqual(['text/plain', 'application/json']);
  });

  it('never overwrites a file already in the Send folder (name (2).md)', async () => {
    await writeFile(path.join(sendFolder, 'notes.md'), 'old');
    const h = await harness();
    expect((await h.post(ATTACH_PATH, one('notes.md', 'new'))).status).toBe(200);
    expect(await readFile(path.join(sendFolder, 'notes.md'), 'utf8')).toBe('old');
    expect(h.sent[0]?.files[0]?.name).toBe('notes (2).md');
  });

  it('a traversal name stays inside the Send folder', async () => {
    const h = await harness();
    expect((await h.post(ATTACH_PATH, one('../../evil.md', 'x'))).status).toBe(200);
    expect(path.dirname(h.sent[0]?.files[0]?.realpath ?? '')).toBe(sendFolder);
    expect(readdirSync(home).sort()).toEqual(['AgentLink']);
  });

  it('refuses a Send folder that became a link elsewhere: no_folder, nothing written', async () => {
    const elsewhere = path.join(home, 'Elsewhere');
    await mkdir(elsewhere);
    await rm(sendFolder, { recursive: true });
    await symlink(elsewhere, sendFolder);
    const h = await harness();
    const res = await h.post(ATTACH_PATH, one('a.md', 'x'));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_folder' });
    expect(await readdir(elsewhere)).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });

  it('no Send folder allowed: 409 no_folder, nothing sent', async () => {
    const h = await harness({ folders: [] });
    const res = await h.post(ATTACH_PATH, one('a.md', 'x'));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_folder' });
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a type outside the allowlist', async () => {
    const h = await harness();
    for (const name of ['run.exe', 'page.html', 'notes.md.exe', 'img.png', 'README']) {
      const res = await h.post(ATTACH_PATH, one(name, 'x'));
      expect(res.status, name).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'type' });
    }
    expect(h.sent).toHaveLength(0);
    expect(await readdir(sendFolder)).toEqual([]);
  });

  it('refuses NUL bytes and invalid UTF-8', async () => {
    const h = await harness();
    for (const data of [new Uint8Array([0x41, 0, 0x42]), new Uint8Array([0xc0, 0xaf])]) {
      const res = await h.post(ATTACH_PATH, one('a.md', data));
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_text' });
    }
    expect(h.sent).toHaveLength(0);
    expect(await readdir(sendFolder)).toEqual([]);
  });

  it('refuses a file over 8 MiB (413), before anything is written', async () => {
    const h = await harness();
    const big = new Uint8Array(8 * 1024 * 1024 + 1).fill(0x61);
    const res = await h.post(ATTACH_PATH, one('big.md', big));
    expect(res.status).toBe(413);
    expect(h.sent).toHaveLength(0);
    expect(await readdir(sendFolder)).toEqual([]);
  }, 30_000);

  it('refuses a malformed body, unknown keys, bad base64, no files, too many files', async () => {
    const h = await harness();
    const bad = [
      encodeUtf8('not json'),
      body([]),
      body({ to: CONTACT_ID, files: [{ name: 'a.md', data: b64('x') }], extra: 1 }),
      body({ to: CONTACT_ID, files: [{ name: 'a.md', data: '!!!' }] }),
      body({ to: CONTACT_ID, files: [] }),
      body({ to: 'Marko', files: [{ name: 'a.md', data: b64('x') }] }),
      body({
        to: CONTACT_ID,
        files: Array.from({ length: 6 }, (_, i) => ({ name: `f${String(i)}.md`, data: b64('x') })),
      }),
    ];
    for (const b of bad) {
      const res = await h.post(ATTACH_PATH, b);
      expect(res.status).toBe(400);
    }
    expect(h.sent).toHaveLength(0);
  });

  it('refuses an unknown or unpaired contact, nothing written', async () => {
    const h = await harness();
    const unknown = await h.post(
      ATTACH_PATH,
      body({ to: `0x${hex(20, '9f')}`, files: [{ name: 'a.md', data: b64('x') }] }),
    );
    expect(unknown.status).toBe(404);
    const pending = await h.post(
      ATTACH_PATH,
      body({ to: PENDING_ID, files: [{ name: 'a.md', data: b64('x') }] }),
    );
    expect(pending.status).toBe(409);
    expect(JSON.parse(pending.body)).toEqual({ error: 'not_ready' });
    expect(await readdir(sendFolder)).toEqual([]);
  });

  it('a refused send removes the file it wrote', async () => {
    const h = await harness({ result: { status: 'rejected', code: 'POLICY_DENIED' } });
    const res = await h.post(ATTACH_PATH, one('a.md', 'x'));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'policy' });
    expect(await readdir(sendFolder)).toEqual([]);
  });

  it('IR-ATTACH-1 F-3: another allowed folder is never used; no Send folder is no_folder', async () => {
    const elsewhere = path.join(home, 'Elsewhere');
    await mkdir(elsewhere);
    const h = await harness({ folders: ['~/Elsewhere'] });
    const res = await h.post(ATTACH_PATH, one('a.md', 'x'));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_folder' });
    expect(await readdir(elsewhere)).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });

  it('IR-ATTACH-1 F-4: the page request ID reaches core as clientRequestId; a bad one is refused', async () => {
    const h = await harness();
    const id = 'AbCdEfGhIjKlMnOpQrSt_-';
    expect((await h.post(ATTACH_PATH, one('a.md', 'x', { requestId: id }))).status).toBe(200);
    expect(h.sent[0]?.clientRequestId).toBe(`attach:${id}`);
    expect((await h.post(ATTACH_PATH, one('b.md', 'x'))).status).toBe(200);
    expect(h.sent[1]?.clientRequestId).toBeUndefined();
    for (const bad of ['short', 'has space in it here', 'x'.repeat(65), 42]) {
      const res = await h.post(ATTACH_PATH, one('c.md', 'x', { requestId: bad }));
      expect(res.status).toBe(400);
    }
    expect(h.sent).toHaveLength(2);
  });

  describe('IR-ATTACH-1 F-1: the limits are taken before the body is read', () => {
    it('no declared length: 411; a declared length over the cap: 413, nothing counted', async () => {
      const h = await harness();
      const chunked = await h.post(ATTACH_PATH, one('a.md', 'x'), {}, ['Content-Length']);
      expect(chunked.status).toBe(411);
      const over = await h.post(ATTACH_PATH, one('a.md', 'x'), {
        'Content-Length': String(ATTACH_MAX_BODY_BYTES + 1),
      });
      expect(over.status).toBe(413);
      expect(h.sent).toHaveLength(0);
      // Neither took a slot: 20 more still go through.
      for (let i = 0; i < 20; i += 1) {
        expect((await h.post(ATTACH_PATH, one(`n${String(i)}.md`, 'x'))).status).toBe(200);
      }
    });

    it('at most 20 a minute: the 21st is 429 wait with Retry-After, before its body is used', async () => {
      const h = await harness();
      for (let i = 0; i < 20; i += 1) {
        // A refused body still takes its slot (the slot is taken before reading).
        const res = await h.post(ATTACH_PATH, one(i % 2 === 0 ? `f${String(i)}.md` : 'x.exe', 'x'));
        expect([200, 400]).toContain(res.status);
      }
      const res = await h.post(ATTACH_PATH, one('last.md', 'x'));
      expect(res.status).toBe(429);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'wait' });
      expect(h.sent.map((s) => s.files[0]?.name)).not.toContain('last.md');
    });

    it('parallel requests: at most 2 at once, the rest 429', async () => {
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const h = await harness({ gate });
      const first = [
        h.post(ATTACH_PATH, one('p1.md', 'x')),
        h.post(ATTACH_PATH, one('p2.md', 'x')),
      ];
      // Let both reach the (held) send.
      await new Promise((r) => setTimeout(r, 200));
      const third = await h.post(ATTACH_PATH, one('p3.md', 'x'));
      expect(third.status).toBe(429);
      open();
      const done = await Promise.all(first);
      expect(done.map((d) => d.status)).toEqual([200, 200]);
      expect(h.sent).toHaveLength(2);
      // Once they finished, the next one goes through.
      expect((await h.post(ATTACH_PATH, one('p4.md', 'x'))).status).toBe(200);
    });
  });

  describe('the gate (session, CSRF, Origin, fetch metadata, octet-stream)', () => {
    it('without the session cookie: 401, nothing sent', async () => {
      const h = await harness();
      const res = await h.post(ATTACH_PATH, one('a.md', 'x'), {}, ['Cookie']);
      expect(res.status).toBe(401);
      expect(h.sent).toHaveLength(0);
    });
    it('without the CSRF header: 403', async () => {
      const h = await harness();
      expect((await h.post(ATTACH_PATH, one('a.md', 'x'), {}, ['X-AgentLink-CSRF'])).status).toBe(
        403,
      );
      expect(h.sent).toHaveLength(0);
    });
    it('with a wrong CSRF value: 403', async () => {
      const h = await harness();
      const res = await h.post(ATTACH_PATH, one('a.md', 'x'), {
        'X-AgentLink-CSRF': 'A'.repeat(43),
      });
      expect(res.status).toBe(403);
    });
    it('without or with another Origin: 403', async () => {
      const h = await harness();
      expect((await h.post(ATTACH_PATH, one('a.md', 'x'), {}, ['Origin'])).status).toBe(403);
      expect(
        (await h.post(ATTACH_PATH, one('a.md', 'x'), { Origin: 'http://evil.example' })).status,
      ).toBe(403);
      expect(h.sent).toHaveLength(0);
    });
    it('a cross-site fetch: 403', async () => {
      const h = await harness();
      const res = await h.post(ATTACH_PATH, one('a.md', 'x'), { 'Sec-Fetch-Site': 'cross-site' });
      expect(res.status).toBe(403);
    });
    it('a form or JSON content type: 415', async () => {
      const h = await harness();
      for (const type of ['application/json', 'multipart/form-data; boundary=x', 'text/plain']) {
        const res = await h.post(ATTACH_PATH, one('a.md', 'x'), { 'Content-Type': type });
        expect(res.status).toBe(415);
      }
      expect(h.sent).toHaveLength(0);
    });
    it('a query, an operation input or a presence header: 400', async () => {
      const h = await harness();
      expect((await h.post(`${ATTACH_PATH}?x=1`, one('a.md', 'x'))).status).toBe(400);
      expect(
        (
          await h.post(ATTACH_PATH, one('a.md', 'x'), {
            'X-AgentLink-Input': encodeBase64url(encodeUtf8('{}')),
          })
        ).status,
      ).toBe(400);
      expect(
        (await h.post(ATTACH_PATH, one('a.md', 'x'), { 'X-AgentLink-Presence': 'code' })).status,
      ).toBe(400);
      expect(h.sent).toHaveLength(0);
    });
    it('GET is not a route: 405', async () => {
      const h = await harness();
      const res = await send(h.port, ATTACH_PATH, { method: 'GET' });
      expect([401, 405]).toContain(res.status);
    });
  });

  it('no path and no file name in any event, console line or error answer', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const h = await harness();
    const answers: string[] = [];
    answers.push((await h.post(ATTACH_PATH, one(`${SECRET_NAME}.md`, 'x'))).body);
    answers.push((await h.post(ATTACH_PATH, one(`${SECRET_NAME}.exe`, 'x'))).body);
    answers.push((await h.post(ATTACH_PATH, one(`${SECRET_NAME}.md`, new Uint8Array([0])))).body);
    const all = [...lines, ...answers, JSON.stringify(h.events)].join('\n');
    expect(all).not.toContain(SECRET_NAME);
    expect(all).not.toContain(home);
    expect(all).not.toContain('AgentLink/Send');
  });
});

describe('ATT-APP-ATTACH: the MCP side cannot reach the attach route (I-4)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, '../../../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name === 'node_modules' || e.name === 'dist'
        ? []
        : e.isDirectory()
          ? walk(path.join(dir, e.name))
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
            ? [path.join(dir, e.name)]
            : [],
    );

  it('no MCP tool or CLI tool source names the route, its desk or the Send folder writer', () => {
    const roots = [
      path.join(repo, 'packages/mcp-tools/src'),
      path.join(repo, 'apps/cli/src/tools'),
      path.join(repo, 'apps/cli/src/mcp'),
    ];
    let scanned = 0;
    for (const root of roots) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue;
      }
      scanned += files.length;
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const needle of [
          '/api/ui/attach',
          'attachDesk',
          'writeSendFolderFile',
          'send-folder-file',
        ]) {
          expect(text.includes(needle), `${path.relative(repo, file)} names ${needle}`).toBe(false);
        }
      }
    }
    // The MCP tools were really read (the check is not vacuous).
    expect(scanned).toBeGreaterThan(10);
  });

  it('the package entry exports nothing of the route or its desk', async () => {
    const entry = (await import('../index.js')) as Record<string, unknown>;
    // D-152 (FILES-AI-1) amends D-150 (2) for the writer only: the runtime's files platform takes it
    // for core's `contentFile` sends. No MCP or CLI tool source names it (the test above).
    for (const key of Object.keys(entry).filter((k) => k !== 'writeSendFolderFile')) {
      expect(/attach|sendfolderfile/i.test(key), key).toBe(false);
    }
  });
});
