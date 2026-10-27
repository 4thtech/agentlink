// MSG-FILES-IO-h: the file check behind Show in Finder (04 §4 realpath rules; 04 §2.5; D-134).
//
// - The name is the single saved name the store recorded (never from the request); anything that is
//   not one plain segment is refused before the disk is touched.
// - The Inbox folder is resolved to its realpath; the file is opened once, read-only, without
//   following a final link, and that handle is checked: a regular file, directly inside the folder,
//   the same file the path still names. Only then is the checked path handed to the OS revealer.
// - A link (to inside or outside the Inbox), a folder, a missing file, a missing Inbox, or a swap
//   after the open: a fixed outcome, and the revealer never runs. No separate lstat-then-open step.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { revealSavedFile, type RevealSeams } from './reveal-file.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-reveal-')));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function inbox(): string {
  n += 1;
  const folder = join(root, `case-${String(n)}`, 'Inbox');
  mkdirSync(folder, { recursive: true });
  return folder;
}

function seams(over: Partial<RevealSeams> = {}): {
  seams: RevealSeams;
  calls: [string, string][];
} {
  const calls: [string, string][] = [];
  return {
    calls,
    seams: {
      home: root,
      opener: (file, folder) => {
        calls.push([file, folder]);
        return Promise.resolve(true);
      },
      ...over,
    },
  };
}

describe('Show in Finder: the checked file (MSG-FILES-IO-h)', () => {
  it('reveals a regular file directly inside the Inbox, by its realpath, once', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'report (1).pdf'), 'x');
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(folder, 'report (1).pdf', s)).toBe('shown');
    expect(calls).toEqual([[join(folder, 'report (1).pdf'), folder]]);
  });

  it('follows a linked Inbox folder to its realpath (the configured folder may be a link)', async () => {
    const real = inbox();
    const link = join(root, `case-${String(n)}`, 'InboxLink');
    symlinkSync(real, link);
    writeFileSync(join(real, 'a.txt'), 'x');
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(link, 'a.txt', s)).toBe('shown');
    expect(calls).toEqual([[join(real, 'a.txt'), real]]);
  });

  it('a missing file is not_found; the revealer never runs', async () => {
    const folder = inbox();
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(folder, 'gone.pdf', s)).toBe('not_found');
    expect(calls).toHaveLength(0);
  });

  it('refuses a link with the saved name, to inside or outside the Inbox', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'real.pdf'), 'x');
    const outside = join(root, `case-${String(n)}`, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(join(folder, 'real.pdf'), join(folder, 'inside-link.pdf'));
    symlinkSync(outside, join(folder, 'outside-link.pdf'));
    symlinkSync(join(folder, 'nowhere'), join(folder, 'dangling.pdf'));
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(folder, 'inside-link.pdf', s)).toBe('refused');
    expect(await revealSavedFile(folder, 'outside-link.pdf', s)).toBe('refused');
    expect(await revealSavedFile(folder, 'dangling.pdf', s)).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('refuses a folder with the saved name', async () => {
    const folder = inbox();
    mkdirSync(join(folder, 'sub.pdf'));
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(folder, 'sub.pdf', s)).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('refuses any name that is not one plain segment, before touching the disk', async () => {
    const folder = inbox();
    writeFileSync(join(root, `case-${String(n)}`, 'outside.txt'), 'x');
    const { seams: s, calls } = seams();
    for (const name of [
      '',
      '.',
      '..',
      '../outside.txt',
      'sub/x.txt',
      '..\\outside.txt',
      'a\u0000b',
      '/etc/passwd',
      'x‮.txt',
      'a'.repeat(300),
      42 as unknown as string,
    ]) {
      expect(await revealSavedFile(folder, name, s), String(name)).toBe('refused');
    }
    expect(calls).toHaveLength(0);
  });

  it('a missing or non-folder Inbox is unavailable; the revealer never runs', async () => {
    const { seams: s, calls } = seams();
    expect(await revealSavedFile(join(root, 'no-such-inbox'), 'a.txt', s)).toBe('unavailable');
    const file = join(root, 'plain-file');
    writeFileSync(file, 'x');
    expect(await revealSavedFile(file, 'a.txt', s)).toBe('unavailable');
    expect(await revealSavedFile('relative/Inbox', 'a.txt', s)).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('a swap after the open (the file replaced by a link) is refused, fail closed', async () => {
    const folder = inbox();
    const target = join(folder, 'swap.pdf');
    writeFileSync(target, 'x');
    const outside = join(root, `case-${String(n)}`, 'other.txt');
    writeFileSync(outside, 'other');
    const { seams: s, calls } = seams({
      afterOpen: () => {
        renameSync(target, join(folder, 'moved.pdf'));
        symlinkSync(outside, target);
      },
    });
    expect(await revealSavedFile(folder, 'swap.pdf', s)).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('a swap after the open (another file put in its place) is refused, fail closed', async () => {
    const folder = inbox();
    const target = join(folder, 'swap.pdf');
    writeFileSync(target, 'x');
    const { seams: s, calls } = seams({
      afterOpen: () => {
        renameSync(target, join(folder, 'moved.pdf'));
        writeFileSync(target, 'other');
      },
    });
    expect(await revealSavedFile(folder, 'swap.pdf', s)).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('a revealer that fails or throws is not_opened', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'a.txt'), 'x');
    const failing = seams({ opener: () => Promise.resolve(false) });
    expect(await revealSavedFile(folder, 'a.txt', failing.seams)).toBe('not_opened');
    const throwing = seams({ opener: () => Promise.reject(new Error('/Users/x/a.txt')) });
    expect(await revealSavedFile(folder, 'a.txt', throwing.seams)).toBe('not_opened');
  });
});
