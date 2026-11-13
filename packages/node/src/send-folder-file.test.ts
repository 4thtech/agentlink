// ATT-APP-ATTACH (08 §1 "Attach a file"; 04 §4; I-4, I-5, I-7): the owner's attached file, checked
// and written into the open ID's allowed Send folder before the ordinary send.
//
// - The name: core's sanitizeFileName, then the extension allowlist (.md, .markdown, .txt, .json),
//   over a set of hostile names (traversal, separators, control and bidi characters, hidden names,
//   device names, double extensions, very long names).
// - The bytes: at most ATTACH_MAX_FILE_BYTES, no NUL, valid UTF-8.
// - The write: only into a pinned allowed folder (its realpath where it was allowed, never through a
//   link), exclusively (O_EXCL, O_NOFOLLOW, 0600), never over an existing entry or a planted link:
//   `name (2).md`, `name (3).md`, …; nothing outside the folder.
// - Fixed refusals only: no path or name in a result's reason or a thrown error.
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTACH_EXTENSIONS,
  ATTACH_MAX_FILE_BYTES,
  attachName,
  attachProblem,
  writeSendFolderFile,
} from './send-folder-file.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('attachName (sanitised, allowlisted)', () => {
  it('allows exactly .md, .markdown, .txt and .json, in any case', () => {
    expect([...ATTACH_EXTENSIONS].sort()).toEqual(['json', 'markdown', 'md', 'txt']);
    expect(attachName('notes.md')).toBe('notes.md');
    expect(attachName('Plan.MARKDOWN')).toBe('Plan.MARKDOWN');
    expect(attachName('a.txt')).toBe('a.txt');
    expect(attachName('data.Json')).toBe('data.Json');
  });

  it('refuses every other type, also behind a double extension', () => {
    for (const name of [
      'run.exe',
      'notes.md.exe',
      'page.html',
      'x.svg',
      'img.png',
      'script.js',
      'a.command',
      'archive.zip',
      'README',
      'notes.md.',
      'notes.md ',
      'notes.mdx',
      'x.jsonl',
    ]) {
      expect(attachName(name), name).toBeUndefined();
    }
  });

  it('keeps one plain segment for hostile names (never a separator, a dot name or a control)', () => {
    const hostile: Array<[string, string | undefined]> = [
      ['../../etc/evil.md', 'evil.md'],
      ['..\\..\\Windows\\evil.md', 'evil.md'],
      ['/abs/path/x.md', 'x.md'],
      ['.hidden.md', 'hidden.md'],
      ['..md', undefined],
      ['.md', undefined],
      ['..', undefined],
      ['', undefined],
      ['a\u0000b.md', 'ab.md'],
      ['a\nb.md', 'ab.md'],
      ['‮dm.exe', undefined],
      ['evil‮gpj.md', 'evilgpj.md'],
      ['CON.md', '_CON.md'],
      ['nul.txt', '_nul.txt'],
      ['a:b|c?.md', 'a_b_c_.md'],
      ['x​/../y.md', 'y.md'],
    ];
    for (const [raw, want] of hostile) {
      const got = attachName(raw);
      expect(got, JSON.stringify(raw)).toBe(want);
      if (got !== undefined) {
        expect(got.includes('/') || got.includes('\\') || got.startsWith('.')).toBe(false);
        // eslint-disable-next-line no-control-regex
        expect(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/u.test(got)).toBe(false);
      }
    }
  });

  it('keeps a very long name within 255 bytes and its extension', () => {
    const got = attachName(`${'é'.repeat(400)}.md`);
    expect(got).toBeDefined();
    expect(Buffer.byteLength(got as string, 'utf8')).toBeLessThanOrEqual(255);
    expect(got?.endsWith('.md')).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(attachName(undefined)).toBeUndefined();
    expect(attachName(42)).toBeUndefined();
    expect(attachName({ name: 'a.md' })).toBeUndefined();
  });
});

describe('attachProblem (the bytes)', () => {
  it('takes valid UTF-8 text, also empty and with a byte order mark', () => {
    expect(attachProblem(utf8('# Hello\n\nšđčćž 👋\n'))).toBeUndefined();
    expect(attachProblem(new Uint8Array(0))).toBeUndefined();
    expect(attachProblem(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBeUndefined();
  });

  it('refuses a NUL byte', () => {
    expect(attachProblem(new Uint8Array([0x41, 0x00, 0x42]))).toBe('not_text');
  });

  it('refuses invalid UTF-8 (lone continuation, overlong, truncated, surrogate)', () => {
    for (const bytes of [
      [0x80],
      [0xc0, 0xaf],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xff, 0xfe, 0x41, 0x00],
    ]) {
      expect(attachProblem(new Uint8Array(bytes)), String(bytes)).toBe('not_text');
    }
  });

  it('refuses a file over the cap (8 MiB) and takes one exactly at it', () => {
    expect(ATTACH_MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(attachProblem(new Uint8Array(ATTACH_MAX_FILE_BYTES).fill(0x61))).toBeUndefined();
    expect(attachProblem(new Uint8Array(ATTACH_MAX_FILE_BYTES + 1).fill(0x61))).toBe('too_large');
  });
});

describe('writeSendFolderFile', () => {
  let home = '';
  let send = '';
  let outside = '';

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'att-app-attach-')));
    send = path.join(home, 'AgentLink', 'Send');
    await mkdir(send, { recursive: true, mode: 0o700 });
    outside = path.join(home, 'Elsewhere');
    await mkdir(outside, { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const write = (name: string, bytes = utf8('# hi\n'), folders = ['~/AgentLink/Send']) =>
    writeSendFolderFile({ allowedFolders: folders, name, bytes, home });

  it('writes the bytes into the Send folder, mode 0600', async () => {
    const out = await write('notes.md', utf8('# Notes\n'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.name).toBe('notes.md');
    expect(path.dirname(out.realpath)).toBe(send);
    expect(await readFile(out.realpath, 'utf8')).toBe('# Notes\n');
    if (process.platform !== 'win32') {
      expect((await stat(out.realpath)).mode & 0o777).toBe(0o600);
    }
  });

  it('never overwrites: name (2).md, then name (3).md', async () => {
    await writeFile(path.join(send, 'notes.md'), 'old');
    const a = await write('notes.md', utf8('new 1'));
    const b = await write('notes.md', utf8('new 2'));
    expect(a.ok && a.name).toBe('notes (2).md');
    expect(b.ok && b.name).toBe('notes (3).md');
    expect(await readFile(path.join(send, 'notes.md'), 'utf8')).toBe('old');
    expect(await readFile(path.join(send, 'notes (2).md'), 'utf8')).toBe('new 1');
  });

  it('never follows a planted link at the target name', async () => {
    const victim = path.join(outside, 'victim.txt');
    await writeFile(victim, 'keep me');
    await symlink(victim, path.join(send, 'plan.md'));
    const out = await write('plan.md', utf8('attacker? no'));
    expect(out.ok && out.name).toBe('plan (2).md');
    expect(await readFile(victim, 'utf8')).toBe('keep me');
    expect((await lstat(path.join(send, 'plan.md'))).isSymbolicLink()).toBe(true);
  });

  it('a traversal name lands directly inside the Send folder, nothing outside', async () => {
    const out = await write('../../Elsewhere/evil.md');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(path.dirname(out.realpath)).toBe(send);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a Send folder that is a link to somewhere else (pinned realpath)', async () => {
    await rm(send, { recursive: true });
    await symlink(outside, send);
    const out = await write('a.md');
    expect(out).toEqual({ ok: false, reason: 'no_folder' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses when no folder is allowed, or the allowed one is missing', async () => {
    expect(await write('a.md', utf8('x'), [])).toEqual({ ok: false, reason: 'no_folder' });
    expect(await write('a.md', utf8('x'), ['~/AgentLink/Missing'])).toEqual({
      ok: false,
      reason: 'no_folder',
    });
  });

  it('prefers ~/AgentLink/Send over another allowed folder', async () => {
    const out = await write('a.md', utf8('x'), ['~/Elsewhere', '~/AgentLink/Send']);
    expect(out.ok && path.dirname(out.realpath)).toBe(send);
  });

  it('remove() deletes only the file it wrote', async () => {
    const out = await write('a.md');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await out.remove();
    expect(await readdir(send)).toEqual([]);
  });

  it('refuses a name outside the allowlist before writing anything', async () => {
    const out = await write('run.exe');
    expect(out).toEqual({ ok: false, reason: 'type' });
    expect(await readdir(send)).toEqual([]);
  });
});
