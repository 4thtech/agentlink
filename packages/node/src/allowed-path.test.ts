// M1-15: realpath on both sides against a real file system (04 §4 "Allowed folders",
// "Downloads"). Every test works under a throwaway home folder in the OS temp directory. Directory
// links use type 'junction', which Windows creates without admin rights and POSIX ignores, so the
// same symlink-escape tests run on Linux, macOS and Windows (CI `node-os`).
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AllowedPathError,
  createInboxFile,
  openAllowedFile,
  openAllowedFileWith,
  pinFolder,
  resolveAllowedFile,
  stillPinned,
} from './allowed-path.js';

const isWindows = process.platform === 'win32';
/** `it` on POSIX; on Windows the test is not registered at all (the Windows job refuses skips). */
const posixIt: typeof it = isWindows ? ((() => undefined) as unknown as typeof it) : it;
/** A keychain directory protectedRoots() lists for this platform (04 §4). */
const KEYCHAIN_DIR: readonly string[] = isWindows
  ? ['AppData', 'Roaming', 'Microsoft', 'Protect']
  : ['Library', 'Keychains'];
let base: string;
let home: string;
let outside: string;

function link(target: string, at: string): void {
  symlinkSync(target, at, 'junction');
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'agentlink-path-guard-'));
  home = join(base, 'home');
  outside = join(base, 'outside');
  for (const dir of [
    join(home, '.ssh'),
    join(home, '.agentlink'),
    join(home, 'Work', '.git'),
    join(home, 'Work', 'sub'),
    join(home, 'Inbox'),
    join(home, 'dotssh-real'),
    join(home, ...KEYCHAIN_DIR),
    outside,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(home, '.agentlink', 'agent.alko'), 'KEYSTORE');
  writeFileSync(join(home, ...KEYCHAIN_DIR, 'login.keychain-db'), 'KC');
  writeFileSync(join(home, 'Work', 'a.txt'), 'hello');
  writeFileSync(join(home, 'Work', 'sub', 'b.txt'), 'nested');
  writeFileSync(join(home, 'Work', '.env'), 'SECRET=1');
  writeFileSync(join(home, 'Work', '.git', 'config'), '[core]');
  writeFileSync(join(outside, 'loot.txt'), 'outside');
  writeFileSync(join(home, 'dotssh-real', 'id_rsa'), 'PRIVATE2');
  // Links inside the allowed folder that escape it.
  link(join(home, '.ssh'), join(home, 'Work', 'sshdir'));
  link(outside, join(home, 'Work', 'outdir'));
  link(join(home, ...KEYCHAIN_DIR), join(home, 'Work', 'kc'));
  link(join(home, 'Work', '.git'), join(home, 'Work', 'gitdir'));
  // An allowed folder that is itself a link.
  link(join(home, 'Work'), join(home, 'WorkLink'));
  // A second home whose ~/.ssh is a link to another folder, which a Work link then points at.
  mkdirSync(join(base, 'home2', 'Work'), { recursive: true });
  link(join(home, 'dotssh-real'), join(base, 'home2', '.ssh'));
  link(join(home, 'dotssh-real'), join(base, 'home2', 'Work', 'keys'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AllowedPathError);
    return (error as AllowedPathError).code;
  }
  throw new Error('expected an AllowedPathError');
}

const opts = (allowedFolders: string[], h = home) => ({ allowedFolders, home: h });

describe('resolveAllowedFile (04 §4)', () => {
  it('allows a file inside an allowed folder given with ~/', async () => {
    const file = await resolveAllowedFile('~/Work/a.txt', opts(['~/Work']));
    expect(file.realPath).toBe(realpathSync.native(join(home, 'Work', 'a.txt')));
    expect(file.folder).toBe(realpathSync.native(join(home, 'Work')));
    expect(file.size).toBe(5);
    expect(
      (await resolveAllowedFile(join(home, 'Work', 'sub', 'b.txt'), opts(['~/Work']))).size,
    ).toBe(6);
  });

  it('resolves the requested path: a link into an allowed folder reaches the same file', async () => {
    const file = await resolveAllowedFile(join(home, 'Work', 'a.txt'), opts(['~/Work']));
    expect(file.realPath).toBe(realpathSync.native(join(home, 'Work', 'a.txt')));
    const viaLink = await resolveAllowedFile(join(home, 'WorkLink', 'a.txt'), opts(['~/Work']));
    expect(viaLink.realPath).toBe(file.realPath);
  });

  // M1-36b-2-d L3 (IR-M1-36b-2-c-1): an allowed folder is pinned to its real location. Owner
  // commands store the realpath, so a stored folder that now resolves anywhere else (it, or a
  // folder above it, became a link) is not used: a later link cannot widen what is allowed.
  it('does not use an allowed folder that is a link (M1-36b-2-d)', async () => {
    expect(
      await codeOf(resolveAllowedFile(join(home, 'Work', 'a.txt'), opts(['~/WorkLink']))),
    ).toBe('no_allowed_folder');
    expect(
      await codeOf(
        resolveAllowedFile(join(home, 'Work', 'a.txt'), opts(['~/WorkLink', '~/Inbox'])),
      ),
    ).toBe('outside_allowed');
  });

  it('a symlink swapped in for an allowed folder after allow widens nothing (M1-36b-2-d)', async () => {
    const pinned = join(realpathSync.native(home), 'Pinned');
    mkdirSync(pinned);
    writeFileSync(join(pinned, 'ok.txt'), 'ok');
    // Allowed as owner commands store it: the realpath.
    expect((await resolveAllowedFile(join(pinned, 'ok.txt'), opts([pinned]))).size).toBe(2);
    renameSync(pinned, join(home, 'Pinned-old'));
    link(outside, pinned);
    expect(await codeOf(resolveAllowedFile(join(pinned, 'loot.txt'), opts([pinned])))).toBe(
      'no_allowed_folder',
    );
    expect(await codeOf(resolveAllowedFile(join(outside, 'loot.txt'), opts([pinned])))).toBe(
      'no_allowed_folder',
    );
  });

  it('a link swapped in above an allowed folder widens nothing (M1-36b-2-d)', async () => {
    const parent = join(realpathSync.native(home), 'Deep');
    const allowed = join(parent, 'Send');
    mkdirSync(allowed, { recursive: true });
    const decoy = join(base, 'decoy-parent');
    mkdirSync(join(decoy, 'Send'), { recursive: true });
    writeFileSync(join(decoy, 'Send', 'loot.txt'), 'outside');
    renameSync(parent, join(home, 'Deep-old'));
    link(decoy, parent);
    expect(await codeOf(resolveAllowedFile(join(allowed, 'loot.txt'), opts([allowed])))).toBe(
      'no_allowed_folder',
    );
  });

  it('refuses a symlink inside an allowed folder pointing to ~/.ssh', async () => {
    expect(
      await codeOf(
        resolveAllowedFile(join(home, 'Work', 'sshdir', 'id_ed25519'), opts(['~/Work'])),
      ),
    ).toBe('protected');
  });

  it('refuses a symlink pointing at a keychain directory', async () => {
    expect(
      await codeOf(
        resolveAllowedFile(join(home, 'Work', 'kc', 'login.keychain-db'), opts(['~/Work'])),
      ),
    ).toBe('protected');
  });

  it('refuses a symlink when ~/.ssh is itself a link (protected roots are resolved too)', async () => {
    const h2 = join(base, 'home2');
    expect(
      await codeOf(resolveAllowedFile(join(h2, 'Work', 'keys', 'id_rsa'), opts(['~/Work'], h2))),
    ).toBe('protected');
  });

  it('refuses a symlink escaping the allowed folder', async () => {
    expect(
      await codeOf(resolveAllowedFile(join(home, 'Work', 'outdir', 'loot.txt'), opts(['~/Work']))),
    ).toBe('outside_allowed');
  });

  it('refuses ~/.ssh and ~/.agentlink even when the home folder or they are allowed', async () => {
    for (const allowed of ['~', '~/.ssh', '~/.agentlink']) {
      expect(await codeOf(resolveAllowedFile('~/.ssh/id_ed25519', opts([allowed])))).toBe(
        'protected',
      );
      expect(await codeOf(resolveAllowedFile('~/.agentlink/agent.alko', opts([allowed])))).toBe(
        'protected',
      );
    }
  });

  it('refuses hidden files, files in hidden folders and links into them', async () => {
    expect(await codeOf(resolveAllowedFile('~/Work/.env', opts(['~/Work'])))).toBe('hidden');
    expect(await codeOf(resolveAllowedFile('~/Work/.git/config', opts(['~/Work'])))).toBe('hidden');
    expect(await codeOf(resolveAllowedFile('~/Work/gitdir/config', opts(['~/Work'])))).toBe(
      'hidden',
    );
  });

  it('refuses a path outside every allowed folder', async () => {
    expect(await codeOf(resolveAllowedFile(join(outside, 'loot.txt'), opts(['~/Work'])))).toBe(
      'outside_allowed',
    );
  });

  it('refuses when no folder is allowed or none exists (needs_setup)', async () => {
    expect(await codeOf(resolveAllowedFile('~/Work/a.txt', opts([])))).toBe('no_allowed_folder');
    expect(await codeOf(resolveAllowedFile('~/Work/a.txt', opts(['~/Missing'])))).toBe(
      'no_allowed_folder',
    );
  });

  it('refuses relative, dotted and missing paths, and folders', async () => {
    expect(await codeOf(resolveAllowedFile('Work/a.txt', opts(['~/Work'])))).toBe('path_malformed');
    expect(await codeOf(resolveAllowedFile('~/Work/../.ssh/id_ed25519', opts(['~/Work'])))).toBe(
      'path_malformed',
    );
    expect(await codeOf(resolveAllowedFile('~/Work/none.txt', opts(['~/Work'])))).toBe('not_found');
    expect(await codeOf(resolveAllowedFile('~/Work/sub', opts(['~/Work'])))).toBe('not_a_file');
  });

  it('refuses a FIFO or named pipe (opening it would block)', async () => {
    if (isWindows) {
      // Windows has no FIFO in the file system: named pipes live under \\.\pipe\, a device
      // namespace the path parser refuses before anything is opened.
      const pipe = `\\\\.\\pipe\\agentlink-path-guard-${process.pid}`;
      const server = createNetServer();
      await new Promise<void>((resolve) => server.listen(pipe, resolve));
      try {
        expect(await codeOf(resolveAllowedFile(pipe, opts(['~/Work'])))).toBe('path_malformed');
        expect(await codeOf(openAllowedFile(pipe, opts(['~/Work'])))).toBe('path_malformed');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return;
    }
    const fifo = join(home, 'Work', 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(await codeOf(resolveAllowedFile(fifo, opts(['~/Work'])))).toBe('not_a_file');
  });

  it('never puts the path into an error message', async () => {
    try {
      await resolveAllowedFile('~/Work/sshdir/id_ed25519', opts(['~/Work']));
    } catch (error) {
      expect((error as Error).message).not.toContain(home);
      expect((error as Error).message).not.toContain('id_ed25519');
    }
  });
});

describe('openAllowedFile', () => {
  it('opens the checked file read-only', async () => {
    const { file, handle } = await openAllowedFile('~/Work/a.txt', opts(['~/Work']));
    try {
      expect((await handle.readFile()).toString()).toBe('hello');
      expect(file.size).toBe(5);
    } finally {
      await handle.close();
    }
  });

  it('refuses the same paths resolveAllowedFile refuses, without opening them', async () => {
    expect(
      await codeOf(openAllowedFile(join(home, 'Work', 'sshdir', 'id_ed25519'), opts(['~/Work']))),
    ).toBe('protected');
  });

  it('refuses a file replaced by another one after the open (IR-M1-15-1 L1)', async () => {
    const target = join(home, 'Work', 'swap-file.txt');
    writeFileSync(target, 'checked');
    const promise = openAllowedFileWith('~/Work/swap-file.txt', opts(['~/Work']), {
      afterOpen: () => {
        renameSync(target, join(home, 'Work', 'swap-file.old'));
        writeFileSync(target, 'other inode');
      },
    });
    expect(await codeOf(promise)).toBe('changed');
  });

  it('refuses when a folder on the path becomes a link to ~/.ssh before the open (L1)', async () => {
    const dir = join(home, 'Work', 'swapdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'id_ed25519'), 'decoy');
    let swapped = false;
    const promise = openAllowedFileWith('~/Work/swapdir/id_ed25519', opts(['~/Work']), {
      afterCheck: () => {
        renameSync(dir, join(home, 'Work', 'swapdir-old'));
        link(join(home, '.ssh'), dir);
        swapped = true;
      },
    });
    expect(await codeOf(promise)).toBe('protected');
    expect(swapped).toBe(true);
  });

  // POSIX only: Windows refuses to rename a folder that holds an open file, so this swap cannot
  // happen there (registered conditionally, not skipped: the Windows job fails on any skip).
  posixIt(
    'refuses when a folder on the path becomes a link to ~/.ssh after the open (L1)',
    async () => {
      const dir = join(home, 'Work', 'swapdir-post');
      mkdirSync(dir);
      writeFileSync(join(dir, 'id_ed25519'), 'decoy');
      let swapped = false;
      const promise = openAllowedFileWith('~/Work/swapdir-post/id_ed25519', opts(['~/Work']), {
        afterOpen: () => {
          renameSync(dir, join(home, 'Work', 'swapdir-post-old'));
          link(join(home, '.ssh'), dir);
          swapped = true;
        },
      });
      expect(await codeOf(promise)).toBe('protected');
      expect(swapped).toBe(true);
    },
  );

  it('refuses when the allowed folder becomes a link between the check and the open (M1-36b-2-d)', async () => {
    const pinned = join(realpathSync.native(home), 'PinnedOpen');
    mkdirSync(pinned);
    writeFileSync(join(pinned, 'loot.txt'), 'decoy');
    const elsewhere = join(base, 'elsewhere-open');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'loot.txt'), 'outside');
    let swapped = false;
    const promise = openAllowedFileWith(join(pinned, 'loot.txt'), opts([pinned]), {
      afterCheck: () => {
        renameSync(pinned, join(home, 'PinnedOpen-old'));
        link(elsewhere, pinned);
        swapped = true;
      },
    });
    expect(await codeOf(promise)).toBe('no_allowed_folder');
    expect(swapped).toBe(true);
  });

  it('refuses when the file disappears after the open (L1)', async () => {
    const target = join(home, 'Work', 'gone.txt');
    writeFileSync(target, 'x');
    const promise = openAllowedFileWith('~/Work/gone.txt', opts(['~/Work']), {
      afterOpen: () => unlinkSync(target),
    });
    expect(await codeOf(promise)).toBe('not_found');
  });
});

describe('pinFolder and stillPinned (M1-36b-2-d: check, sign and use see one folder)', () => {
  it('pins a real folder and confirms it while nothing changed', async () => {
    const folder = join(realpathSync.native(home), 'PinMe');
    mkdirSync(folder);
    const pin = await pinFolder(folder);
    expect(pin).toBeDefined();
    expect(pin?.path).toBe(folder);
    expect(await stillPinned(pin!)).toBe(true);
  });

  it('never pins a link, a link above it, a file, a missing or a non-real path', async () => {
    expect(await pinFolder(join(home, 'WorkLink'))).toBeUndefined();
    expect(await pinFolder(join(realpathSync.native(home), 'WorkLink', 'sub'))).toBeUndefined();
    expect(await pinFolder(join(realpathSync.native(home), 'Work', 'a.txt'))).toBeUndefined();
    expect(await pinFolder(join(realpathSync.native(home), 'NoSuch'))).toBeUndefined();
    expect(await pinFolder('relative/path')).toBeUndefined();
  });

  it('a folder renamed away and replaced by another real folder is not the pinned one', async () => {
    const folder = join(realpathSync.native(home), 'PinSwap');
    mkdirSync(folder);
    const pin = await pinFolder(folder);
    renameSync(folder, join(home, 'PinSwap-old'));
    mkdirSync(folder);
    expect(await stillPinned(pin!)).toBe(false);
  });

  it('a folder replaced by a link (even to itself, moved) is not the pinned one', async () => {
    const folder = join(realpathSync.native(home), 'PinLink');
    mkdirSync(folder);
    const pin = await pinFolder(folder);
    const moved = join(home, 'PinLink-moved');
    renameSync(folder, moved);
    link(moved, folder);
    expect(await stillPinned(pin!)).toBe(false);
  });

  it('a removed folder is not the pinned one', async () => {
    const folder = join(realpathSync.native(home), 'PinGone');
    mkdirSync(folder);
    const pin = await pinFolder(folder);
    rmSync(folder, { recursive: true });
    expect(await stillPinned(pin!)).toBe(false);
  });
});

describe('createInboxFile (04 §4 "Downloads")', () => {
  it('writes a hostile name as a single sanitised file inside the inbox', async () => {
    const { path, name, handle } = await createInboxFile('~/Inbox', '../../.ssh/authorized_keys', {
      home,
    });
    await handle.writeFile('data');
    await handle.close();
    expect(name).toBe('authorized_keys');
    expect(path).toBe(join(realpathSync.native(join(home, 'Inbox')), 'authorized_keys'));
    expect(readFileSync(path, 'utf8')).toBe('data');
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('PRIVATE');
    if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never overwrites: a clash gets a numbered name', async () => {
    const first = await createInboxFile('~/Inbox', 'report.pdf', { home });
    await first.handle.close();
    const second = await createInboxFile('~/Inbox', 'report.pdf', { home });
    await second.handle.close();
    expect(first.name).toBe('report.pdf');
    expect(second.name).toBe('report (1).pdf');
  });

  it('never writes through a link planted at the target name', async () => {
    const inbox = join(home, 'Inbox');
    link(join(home, '.ssh'), join(inbox, 'planted'));
    const { name, handle } = await createInboxFile('~/Inbox', 'planted', { home });
    await handle.writeFile('x');
    await handle.close();
    expect(name).toBe('planted (1)');
    expect(readFileSync(join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('PRIVATE');
  });

  it('sanitises control characters, hidden names and device names', async () => {
    for (const [raw, expected] of [
      ['a\u0000b\n.txt', 'ab.txt'],
      ['.bashrc', 'bashrc'],
      ['CON', '_CON'],
      ['..', 'file'],
    ] as const) {
      const { name, handle } = await createInboxFile('~/Inbox', raw, { home });
      await handle.close();
      expect(name).toBe(expected);
    }
  });

  it('refuses a missing inbox, a file as inbox and an inbox under a protected root', async () => {
    expect(await codeOf(createInboxFile('~/NoInbox', 'x', { home }))).toBe('inbox_unavailable');
    expect(await codeOf(createInboxFile('~/Work/a.txt', 'x', { home }))).toBe('inbox_unavailable');
    expect(await codeOf(createInboxFile('relative', 'x', { home }))).toBe('inbox_unavailable');
    expect(await codeOf(createInboxFile('~/.agentlink', 'x', { home }))).toBe('protected');
    expect(await codeOf(createInboxFile('~/.ssh', 'x', { home }))).toBe('protected');
  });

  it('refuses a hidden inbox folder, by name or through a link (IR-M1-15-1 L4)', async () => {
    mkdirSync(join(home, '.hidden-inbox'));
    link(join(home, '.hidden-inbox'), join(home, 'VisibleInbox'));
    link(join(home, 'Inbox'), join(home, '.InboxLink'));
    expect(await codeOf(createInboxFile('~/.hidden-inbox', 'x', { home }))).toBe('hidden');
    expect(await codeOf(createInboxFile('~/VisibleInbox', 'x', { home }))).toBe('hidden');
    expect(await codeOf(createInboxFile('~/.InboxLink', 'x', { home }))).toBe('hidden');
  });

  it('keeps numbered clash names within 255 bytes (IR-M1-15-1 L4)', async () => {
    const long = `${'č'.repeat(200)}.pdf`; // 404 bytes before sanitising
    const names: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const created = await createInboxFile('~/Inbox', long, { home });
      await created.handle.close();
      names.push(created.name);
    }
    expect(new Set(names).size).toBe(12);
    for (const name of names) {
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
      expect(name.endsWith('.pdf')).toBe(true);
    }
    expect(names[11]).toMatch(/ \(11\)\.pdf$/);
  });
});
