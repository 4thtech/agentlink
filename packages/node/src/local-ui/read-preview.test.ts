// REL051-A34 (D-149; 08 §1; 04 §4 realpath rules): the file read behind the in-app preview of a
// received text file.
//
// - Input: the Inbox folder from the rules in force and the single saved name the store recorded,
//   never a name or a path from the request. A name that is not one plain segment is refused before
//   the disk is touched.
// - The file is opened once, read-only, without following a final link, and that handle is checked
//   (a regular file, directly inside the Inbox, the same file the path still names), as Show in
//   Finder does. A link (inside or outside the Inbox), a folder, a FIFO or a swap after the open is
//   refused; a missing file is not_found.
// - At most the cap is read: a larger file is too_large. The bytes must match the plaintext hash the
//   message carried (changed otherwise) and be UTF-8 text without NUL (not_text otherwise).
// - Outcomes are fixed words; nothing is logged.
import { execFileSync } from 'node:child_process';
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
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readSavedText, type PreviewReadSeams } from './read-preview.js';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentlink-preview-')));
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

const hashOf = (bytes: Uint8Array | string): string =>
  encodeHex(sha256(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes));

const PLAN = '# Build plan\n\n- step one\n- step two\n';
const seams = (over: Partial<PreviewReadSeams> = {}): PreviewReadSeams => ({ home: root, ...over });
const limits = (text: Uint8Array | string, maxBytes = 256 * 1024) => ({
  sha256: hashOf(text),
  maxBytes,
});

describe('in-app preview: the checked read (REL051-A34)', () => {
  it('reads a saved UTF-8 file directly inside the Inbox whose bytes match the hash', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'plan.md'), PLAN);
    expect(await readSavedText(folder, 'plan.md', limits(PLAN), seams())).toEqual({
      status: 'ok',
      text: PLAN,
    });
  });

  it('drops a leading byte order mark', async () => {
    const folder = inbox();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('hi')]);
    writeFileSync(join(folder, 'a.txt'), bytes);
    expect(await readSavedText(folder, 'a.txt', limits(bytes), seams())).toEqual({
      status: 'ok',
      text: 'hi',
    });
  });

  it('refuses a name that is not one plain segment before touching the disk', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'plan.md'), PLAN);
    for (const name of ['../plan.md', 'sub/plan.md', '..', '.', '', 'a\\b.md', 'a‮b.md']) {
      expect(await readSavedText(folder, name, limits(PLAN), seams()), name).toEqual({
        status: 'refused',
      });
    }
  });

  it('never follows a link, to inside or outside the Inbox', async () => {
    const folder = inbox();
    const outside = join(root, `case-${String(n)}`, 'secret.md');
    writeFileSync(outside, PLAN);
    writeFileSync(join(folder, 'real.md'), PLAN);
    symlinkSync(outside, join(folder, 'out.md'));
    symlinkSync(join(folder, 'real.md'), join(folder, 'in.md'));
    symlinkSync(join(folder, 'nowhere.md'), join(folder, 'dangling.md'));
    for (const name of ['out.md', 'in.md', 'dangling.md']) {
      expect(await readSavedText(folder, name, limits(PLAN), seams()), name).toEqual({
        status: 'refused',
      });
    }
  });

  it('refuses a link where the open cannot refuse it (the Windows path)', async () => {
    const folder = inbox();
    const outside = join(root, `case-${String(n)}`, 'secret.md');
    writeFileSync(outside, PLAN);
    symlinkSync(outside, join(folder, 'out.md'));
    expect(
      await readSavedText(folder, 'out.md', limits(PLAN), seams({ openFollowsLinks: true })),
    ).toEqual({ status: 'refused' });
  });

  it('refuses a folder and a FIFO; a missing file is not_found', async () => {
    const folder = inbox();
    mkdirSync(join(folder, 'dir.md'));
    expect(await readSavedText(folder, 'dir.md', limits(PLAN), seams())).toEqual({
      status: 'refused',
    });
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(folder, 'pipe.md')]);
      expect(await readSavedText(folder, 'pipe.md', limits(PLAN), seams())).toEqual({
        status: 'refused',
      });
    }
    expect(await readSavedText(folder, 'gone.md', limits(PLAN), seams())).toEqual({
      status: 'not_found',
    });
  });

  it('refuses a file swapped for another after the open', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'plan.md'), PLAN);
    writeFileSync(join(folder, 'other.md'), PLAN);
    const afterOpen = (): void => {
      renameSync(join(folder, 'other.md'), join(folder, 'plan.md'));
    };
    expect(await readSavedText(folder, 'plan.md', limits(PLAN), seams({ afterOpen }))).toEqual({
      status: 'refused',
    });
  });

  it('an Inbox folder that does not exist is unavailable', async () => {
    expect(
      await readSavedText(join(root, 'no-such', 'Inbox'), 'plan.md', limits(PLAN), seams()),
    ).toEqual({ status: 'unavailable' });
  });

  it('a file over the cap is too_large and is not read past the cap', async () => {
    const folder = inbox();
    const big = 'x'.repeat(2048);
    writeFileSync(join(folder, 'big.md'), big);
    expect(await readSavedText(folder, 'big.md', limits(big, 1024), seams())).toEqual({
      status: 'too_large',
    });
  });

  it('bytes that do not match the hash the message carried are changed', async () => {
    const folder = inbox();
    writeFileSync(join(folder, 'plan.md'), `${PLAN}edited\n`);
    expect(await readSavedText(folder, 'plan.md', limits(PLAN), seams())).toEqual({
      status: 'changed',
    });
  });

  it('binary bytes, invalid UTF-8 or a NUL are not_text', async () => {
    const folder = inbox();
    const cases: Record<string, Uint8Array> = {
      'bin.md': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'bad.md': new Uint8Array([0x61, 0xc3, 0x28, 0x62]),
      'nul.md': new TextEncoder().encode('a\u0000b'),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      writeFileSync(join(folder, name), bytes);
      expect(await readSavedText(folder, name, limits(bytes), seams()), name).toEqual({
        status: 'not_text',
      });
    }
  });

  it('logs nothing, whatever the outcome', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const folder = inbox();
    writeFileSync(join(folder, 'plan.md'), PLAN);
    await readSavedText(folder, 'plan.md', limits(PLAN), seams());
    await readSavedText(folder, 'gone.md', limits(PLAN), seams());
    await readSavedText(folder, '../x', limits(PLAN), seams());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
