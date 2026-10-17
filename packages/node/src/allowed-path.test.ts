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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AllowedPathError,
  createInboxFile,
  openAllowedFile,
  openAllowedFileWith,
  resolveAllowedFile,
} from './allowed-path.js';

const isWindows = process.platform === 'win32';
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
    join(home, 'Library', 'Keychains'),
    outside,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(home, '.agentlink', 'agent.alko'), 'KEYSTORE');
  writeFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'KC');
  writeFileSync(join(home, 'Work', 'a.txt'), 'hello');
  writeFileSync(join(home, 'Work', 'sub', 'b.txt'), 'nested');
  writeFileSync(join(home, 'Work', '.env'), 'SECRET=1');
  writeFileSync(join(home, 'Work', '.git', 'config'), '[core]');
  writeFileSync(join(outside, 'loot.txt'), 'outside');
  writeFileSync(join(home, 'dotssh-real', 'id_rsa'), 'PRIVATE2');
  // Links inside the allowed folder that escape it.
  link(join(home, '.ssh'), join(home, 'Work', 'sshdir'));
  link(outside, join(home, 'Work', 'outdir'));
  link(join(home, 'Library', 'Keychains'), join(home, 'Work', 'kc'));
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
    expect(file.realPath).toBe(realpathSync(join(home, 'Work', 'a.txt')));
    expect(file.folder).toBe(realpathSync(join(home, 'Work')));
    expect(file.size).toBe(5);
    expect(
      (await resolveAllowedFile(join(home, 'Work', 'sub', 'b.txt'), opts(['~/Work']))).size,
    ).toBe(6);
  });

  it('resolves the allowed folder too: a linked allowed folder covers its target', async () => {
    const file = await resolveAllowedFile(join(home, 'Work', 'a.txt'), opts(['~/WorkLink']));
    expect(file.realPath).toBe(realpathSync(join(home, 'Work', 'a.txt')));
    const viaLink = await resolveAllowedFile(join(home, 'WorkLink', 'a.txt'), opts(['~/Work']));
    expect(viaLink.realPath).toBe(file.realPath);
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

  it.skipIf(isWindows)('refuses a FIFO (opening it would block)', async () => {
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

  it('refuses when a folder on the path becomes a link to ~/.ssh after the open (L1)', async () => {
    const dir = join(home, 'Work', 'swapdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'id_ed25519'), 'decoy');
    const promise = openAllowedFileWith('~/Work/swapdir/id_ed25519', opts(['~/Work']), {
      afterOpen: () => {
        renameSync(dir, join(home, 'Work', 'swapdir-old'));
        link(join(home, '.ssh'), dir);
      },
    });
    expect(await codeOf(promise)).toBe('protected');
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

describe('createInboxFile (04 §4 "Downloads")', () => {
  it('writes a hostile name as a single sanitised file inside the inbox', async () => {
    const { path, name, handle } = await createInboxFile('~/Inbox', '../../.ssh/authorized_keys', {
      home,
    });
    await handle.writeFile('data');
    await handle.close();
    expect(name).toBe('authorized_keys');
    expect(path).toBe(join(realpathSync(join(home, 'Inbox')), 'authorized_keys'));
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
