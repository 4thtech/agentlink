// M1-9d-1: the Node files platform of the CLI (src/runtime/files.ts; 04 §4, 06 §2.3, D-84, D-48).
// Real file system under a temporary home: the allowed-folder check of `path` arguments (never
// opening a refused file), the inbox folder's file operations (exclusive create without following a
// link, mode 0600, rename that never overwrites), and the drop fetch guard (the configured origin
// only, no redirects).
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardedDropFetch, nodeFileOpener, nodeFilesPlatform } from './files.js';

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'agentlink-rt-files-')));
  await mkdir(path.join(home, 'Work', 'sub'), { recursive: true });
  await writeFile(path.join(home, 'Work', 'a.txt'), 'hello');
  await writeFile(path.join(home, 'outside.txt'), 'SECRET');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('nodeFileOpener', () => {
  it('attaches a file inside an allowed folder; opens it only when read; hashes what it read', async () => {
    let opens = 0;
    const opener = nodeFileOpener({ home, onOpen: () => void (opens += 1) });
    const outcome = await opener.attach('~/Work/a.txt', ['~/Work']);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.file.name).toBe('a.txt');
    expect(outcome.file.size).toBe(5);
    expect(outcome.file.file.realpath).toBe(path.join(home, 'Work', 'a.txt'));
    expect(opens).toBe(0);
    const source = await outcome.file.file.open();
    const chunks: Uint8Array[] = [];
    if (source instanceof Uint8Array) chunks.push(source);
    else for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('hello');
    expect(opens).toBe(1);
    expect(await outcome.file.plaintextSha256()).toBe(
      encodeHex(sha256(new TextEncoder().encode('hello'))),
    );
  });

  it('a repeat that never read the file still gets the hash (one checked open)', async () => {
    const opener = nodeFileOpener({ home });
    const outcome = await opener.attach(path.join(home, 'Work', 'a.txt'), ['~/Work']);
    if (!outcome.ok) throw new Error('not attached');
    expect(await outcome.file.plaintextSha256()).toBe(
      encodeHex(sha256(new TextEncoder().encode('hello'))),
    );
  });

  it.each([
    ['no folder', (h: string) => `${h}/Work/a.txt`, [], 'no_folder'],
    ['a missing folder only', (h: string) => `${h}/Work/a.txt`, ['~/Missing'], 'no_folder'],
    ['outside', (h: string) => `${h}/outside.txt`, ['~/Work'], 'outside_folder'],
    ['traversal', (h: string) => `${h}/Work/../outside.txt`, ['~/Work'], 'not_allowed'],
    ['relative', () => 'Work/a.txt', ['~/Work'], 'not_allowed'],
    ['a folder', (h: string) => `${h}/Work/sub`, ['~/Work'], 'not_allowed'],
    ['missing', (h: string) => `${h}/Work/none.txt`, ['~/Work'], 'not_found'],
  ] as const)('%s → %s, never opened', async (_label, arg, folders, reason) => {
    let opens = 0;
    const opener = nodeFileOpener({ home, onOpen: () => void (opens += 1) });
    const outcome = await opener.attach(arg(home), folders);
    expect(outcome).toEqual({ ok: false, reason });
    expect(opens).toBe(0);
  });

  it('a symbolic link inside the folder that points outside is outside_folder', async () => {
    await symlink(path.join(home, 'outside.txt'), path.join(home, 'Work', 'link.txt'));
    const outcome = await nodeFileOpener({ home }).attach(path.join(home, 'Work', 'link.txt'), [
      '~/Work',
    ]);
    expect(outcome).toEqual({ ok: false, reason: 'outside_folder' });
  });

  it('a hidden file and a protected folder are not_allowed', async () => {
    await writeFile(path.join(home, 'Work', '.env'), 'SECRET');
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, '.ssh', 'id'), 'SECRET');
    const opener = nodeFileOpener({ home });
    expect(await opener.attach(path.join(home, 'Work', '.env'), ['~/Work'])).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await opener.attach('~/.ssh/id', ['~/.ssh', '~/Work'])).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });
});

describe('nodeFilesPlatform', () => {
  it('allowedFolderRealpaths: the realpath of each existing folder, ~ expanded', async () => {
    const platform = nodeFilesPlatform({ home, drop: false });
    expect(await platform.allowedFolderRealpaths(['~/Work', '~/Missing'])).toEqual([
      path.join(home, 'Work'),
    ]);
  });

  it('inbox: creates the default inbox folder (0700) and gives file operations inside it', async () => {
    const platform = nodeFilesPlatform({ home, drop: false });
    const inbox = await platform.inbox('~/AgentLink/Inbox');
    expect(inbox.realpath).toBe(path.join(home, 'AgentLink', 'Inbox'));
    expect((await lstat(inbox.realpath)).mode & 0o777).toBe(0o700);
    const handle = await inbox.ops.create('.agentlink-partial-x');
    await handle.write(new TextEncoder().encode('data'));
    await handle.close();
    expect((await lstat(path.join(inbox.realpath, '.agentlink-partial-x'))).mode & 0o777).toBe(
      0o600,
    );
    await expect(inbox.ops.create('.agentlink-partial-x')).rejects.toThrow();
    await writeFile(path.join(inbox.realpath, 'taken.txt'), 'old');
    await expect(inbox.ops.rename('.agentlink-partial-x', 'taken.txt')).rejects.toThrow();
    expect(await readFile(path.join(inbox.realpath, 'taken.txt'), 'utf8')).toBe('old');
    await inbox.ops.rename('.agentlink-partial-x', 'final.txt');
    expect(await readFile(path.join(inbox.realpath, 'final.txt'), 'utf8')).toBe('data');
    expect([...(await inbox.ops.list())].sort()).toEqual(['final.txt', 'taken.txt']);
    await inbox.ops.remove('final.txt');
    await inbox.ops.remove('final.txt'); // already gone: not an error
    for (const bad of ['../x', 'a/b', '..', '.', '']) {
      await expect(inbox.ops.create(bad)).rejects.toThrow();
    }
  });

  it('inbox: a planted symbolic link is never followed by create', async () => {
    const platform = nodeFilesPlatform({ home, drop: false });
    const inbox = await platform.inbox('~/AgentLink/Inbox');
    await symlink(path.join(home, 'outside.txt'), path.join(inbox.realpath, 'evil.txt'));
    await expect(inbox.ops.create('evil.txt')).rejects.toThrow();
    expect(await readFile(path.join(home, 'outside.txt'), 'utf8')).toBe('SECRET');
  });

  it('inbox: a hidden or protected inbox folder is refused', async () => {
    const platform = nodeFilesPlatform({ home, drop: false });
    await expect(platform.inbox('~/.hidden/Inbox')).rejects.toThrow();
    await expect(platform.inbox('~/.agentlink/Inbox')).rejects.toThrow();
    await expect(platform.inbox('relative/Inbox')).rejects.toThrow();
  });

  it('with drop: false there is no drop; by default the drop is configured', () => {
    expect(nodeFilesPlatform({ home, drop: false }).drop).toBeUndefined();
    expect(nodeFilesPlatform({ home }).drop).toBeDefined();
  });
});

describe('guardedDropFetch', () => {
  it('passes only https requests to the configured origin, never following redirects', async () => {
    const seen: Request[] = [];
    const fetch = guardedDropFetch('https://drop.example', (request) => {
      seen.push(request);
      return Promise.resolve(new Response('ok'));
    });
    await fetch(new Request('https://drop.example/v1/uploads', { method: 'POST', body: 'x' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('manual');
    for (const url of [
      'https://other.example/v1/uploads',
      'http://drop.example/v1/uploads',
      'https://drop.example.evil.test/v1',
      'https://user@drop.example/v1',
    ]) {
      await expect(fetch(new Request(url))).rejects.toThrow();
    }
    expect(seen).toHaveLength(1);
  });
});
