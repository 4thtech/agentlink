// REL051-A34 (D-149; 08 §1; 04 §4; I-4, I-5, I-7): `GET /api/ui/files/received/preview?id=<item ID>`,
// the in-app preview of one received text file.
//
// - A read route behind the server's read gate (session, CSRF, Host, Origin, fetch metadata), like
//   its siblings: no presence, no signing, no store write. Not an MCP tool (I-4).
// - The query is exactly one `id`, `<envelope ID>.<index>`; anything else is 400 `bad_request` and is
//   never echoed. Never a name or a path from the request: the handler reads the saved name and the
//   plaintext hash from the store and the Inbox folder from the rules in force.
// - A name whose kind is not text, or a stated size over the cap, is refused before the disk is
//   touched. A file not saved yet is 409 `not_saved`.
// - The answer is exactly `{kind, size, text}`: never the name, the folder, a path, a link, a hash or
//   an error's text. Nothing is logged here.
import { describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import { UI_NOT_SET_UP, UI_UNAVAILABLE, type LocalUiResult } from '../route-types.js';
import type { PreviewReadOutcome } from '../read-preview.js';
import { createLocalUiRoutes } from '../routes.js';
import { createFilesPreviewRoute, filesPreviewRoute } from './files-preview.js';

const ID = `${'a1'.repeat(32)}.00`;
const INBOX = '/Users/someone/AgentLink/Inbox';
const HASH = 'ab'.repeat(32);
const PLAN = '# Plan\n\nBuild it.\n';

interface Source {
  name: string;
  size: number;
  plaintextSha256: string;
  savedName: string | null;
}

function setup(
  options: {
    source?: Source | null | 'throws';
    policy?: () => Promise<unknown>;
    read?: PreviewReadOutcome | 'throws';
    noClient?: boolean;
  } = {},
) {
  const seen = { sources: [] as string[], reads: [] as unknown[][] };
  const source: Source | null | 'throws' =
    options.source === undefined
      ? { name: 'plan.md', size: PLAN.length, plaintextSha256: HASH, savedName: 'plan.md' }
      : options.source;
  const client = {
    agentId: 'a',
    filesIo: {
      previewSource: (id: string) => {
        seen.sources.push(id);
        return source === 'throws' ? Promise.reject(new Error(`/secret/${id}`)) : Promise.resolve(source);
      },
    },
    policy: {
      load:
        options.policy ??
        (() =>
          Promise.resolve({ mode: 'signed', version: 3, policy: { files: { inboxFolder: INBOX } } })),
    },
  } as unknown as LocalUiReadClient;
  const context: LocalUiContext = {
    client: options.noClient === true ? undefined : client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
  const route = createFilesPreviewRoute((...args: unknown[]) => {
    seen.reads.push(args);
    if (options.read === 'throws') return Promise.reject(new Error('/Users/someone/x'));
    return Promise.resolve(options.read ?? { status: 'ok', text: PLAN });
  });
  const run = (query: string): Promise<LocalUiResult> =>
    route.handler(context, { params: {}, query: new URLSearchParams(query) });
  return { run, seen };
}

describe('file preview route (REL051-A34)', () => {
  it('is a GET read route at the fixed path, without presence, in the default registry', () => {
    expect(filesPreviewRoute).toMatchObject({
      method: 'GET',
      path: '/api/ui/files/received/preview',
      presence: false,
    });
    const listed = createLocalUiRoutes()
      .routes()
      .filter((r) => r.path === '/api/ui/files/received/preview');
    expect(listed.map((r) => `${r.method} ${String(r.presence)}`)).toEqual(['GET false']);
  });

  it('answers exactly kind, size and text for a saved Markdown file', async () => {
    const { run, seen } = setup();
    const result = await run(`id=${ID}`);
    expect(result).toEqual({
      status: 200,
      body: { kind: 'markdown', size: PLAN.length, text: PLAN },
    });
    expect(seen.sources).toEqual([ID]);
    // The checked read gets only the store's saved name, the rules' folder, the hash and the cap.
    expect(seen.reads).toEqual([[INBOX, 'plan.md', { sha256: HASH, maxBytes: 256 * 1024 }]]);
  });

  it('takes only one id: anything else is bad_request and never echoed', async () => {
    for (const query of [
      '',
      'id=',
      `id=${ID}&id=${ID}`,
      `id=${ID}&path=/etc/passwd`,
      `name=plan.md`,
      'id=../../etc/passwd',
      `id=${ID}/x`,
      `id=${'a'.repeat(65)}.00`,
      `id=${ID.slice(0, -1)}`,
      'id=%2Fetc%2Fpasswd',
    ]) {
      const { run, seen } = setup();
      const result = await run(query);
      expect(result, query).toEqual({ status: 400, body: { error: 'bad_request' } });
      expect(seen.sources, query).toEqual([]);
      expect(seen.reads, query).toEqual([]);
    }
  });

  it('an unknown or another agent’s ID is not_found; nothing is read', async () => {
    const { run, seen } = setup({ source: null });
    expect(await run(`id=${ID}`)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(seen.reads).toEqual([]);
  });

  it('a file not saved yet is not_saved; nothing is read', async () => {
    const { run, seen } = setup({
      source: { name: 'plan.md', size: 10, plaintextSha256: HASH, savedName: null },
    });
    expect(await run(`id=${ID}`)).toEqual({ status: 409, body: { error: 'not_saved' } });
    expect(seen.reads).toEqual([]);
  });

  it('a name that is not a text kind is not_text before the disk is touched', async () => {
    for (const name of ['tool.exe', 'photo.png', 'plan.md.download', 'README', 'archive.zip']) {
      const { run, seen } = setup({
        source: { name, size: 10, plaintextSha256: HASH, savedName: name },
      });
      expect(await run(`id=${ID}`), name).toEqual({ status: 415, body: { error: 'not_text' } });
      expect(seen.reads, name).toEqual([]);
    }
  });

  it('a stated size over the cap is too_large before the disk is touched', async () => {
    const { run, seen } = setup({
      source: { name: 'plan.md', size: 256 * 1024 + 1, plaintextSha256: HASH, savedName: 'plan.md' },
    });
    expect(await run(`id=${ID}`)).toEqual({ status: 413, body: { error: 'too_large' } });
    expect(seen.reads).toEqual([]);
  });

  it('maps each read outcome to one fixed answer', async () => {
    const cases: [PreviewReadOutcome, number, string][] = [
      [{ status: 'not_found' }, 404, 'not_found'],
      [{ status: 'refused' }, 403, 'refused'],
      [{ status: 'unavailable' }, 503, 'unavailable'],
      [{ status: 'too_large' }, 413, 'too_large'],
      [{ status: 'changed' }, 409, 'changed'],
      [{ status: 'not_text' }, 415, 'not_text'],
    ];
    for (const [read, status, error] of cases) {
      const { run } = setup({ read });
      expect(await run(`id=${ID}`), error).toEqual({ status, body: { error } });
    }
  });

  it('fails closed without the error text: no client, rules that fail closed, a throwing store or read', async () => {
    expect(await setup({ noClient: true }).run(`id=${ID}`)).toBe(UI_NOT_SET_UP);
    const closed = setup({
      policy: () => Promise.resolve({ mode: 'fail_closed', reason: 'x' }),
    });
    expect(await closed.run(`id=${ID}`)).toBe(UI_UNAVAILABLE);
    expect(closed.seen.reads).toEqual([]);
    const noFolder = setup({
      policy: () => Promise.resolve({ mode: 'signed', version: 3, policy: { files: {} } }),
    });
    expect(await noFolder.run(`id=${ID}`)).toBe(UI_UNAVAILABLE);
    for (const options of [{ source: 'throws' as const }, { read: 'throws' as const }]) {
      const result = await setup(options).run(`id=${ID}`);
      expect(result).toBe(UI_UNAVAILABLE);
      expect(JSON.stringify(result)).not.toContain('/');
    }
  });

  it('never answers the name, the folder or the hash, and logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { run } = setup({
      source: {
        name: 'secret-name.md',
        size: 5,
        plaintextSha256: HASH,
        savedName: 'secret-name (1).md',
      },
      read: { status: 'ok', text: 'hello' },
    });
    const text = JSON.stringify(await run(`id=${ID}`));
    for (const needle of ['secret-name', INBOX, HASH]) expect(text).not.toContain(needle);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
