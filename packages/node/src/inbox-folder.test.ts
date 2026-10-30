// W4-AUTO-SAVE (S2; D-142; 04 §4.1 "The folder", "Writing the file", "Quarantine mark"): the Node
// side of the Inbox folder rules, the held directory and the quarantine mark.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACOS_QUARANTINE_ATTR,
  ZONE_IDENTIFIER,
  inboxFolderProblem,
  openInboxDir,
  quarantineMark,
  quarantineValue,
} from './inbox-folder.js';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'k3-inbox-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('inboxFolderProblem: the folder rules (04 §4.1)', () => {
  it('passes an own folder (0700) outside the send folders', async () => {
    const home = scratch();
    const inbox = join(home, 'AgentLink', 'Inbox');
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    chmodSync(inbox, 0o700);
    expect(
      await inboxFolderProblem({ realpath: inbox, home, sendFolders: [join(home, 'Send')] }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder writable by group or others',
    async () => {
      const home = scratch();
      const inbox = join(home, 'Shared');
      mkdirSync(inbox);
      chmodSync(inbox, 0o777);
      expect(await inboxFolderProblem({ realpath: inbox, home, sendFolders: [] })).toBe(
        'shared_writable',
      );
    },
  );

  it('refuses a folder another user owns', async () => {
    const home = scratch();
    const inbox = join(home, 'Theirs');
    mkdirSync(inbox, { mode: 0o700 });
    chmodSync(inbox, 0o700);
    const stat = lstatSync(inbox);
    expect(
      await inboxFolderProblem({
        realpath: inbox,
        home,
        sendFolders: [],
        stat,
        uid: stat.uid + 1,
        platform: 'linux',
      }),
    ).toBe('not_owned');
  });

  it('refuses the home folder, a parent of it and a filesystem root', async () => {
    const home = scratch();
    chmodSync(home, 0o700);
    expect(await inboxFolderProblem({ realpath: home, home, sendFolders: [] })).toBe(
      'home_or_root',
    );
    const inner = join(home, 'h');
    mkdirSync(inner, { mode: 0o700 });
    expect(await inboxFolderProblem({ realpath: home, home: inner, sendFolders: [] })).toBe(
      'home_or_root',
    );
  });

  it('refuses a folder equal to, inside or containing a send folder', async () => {
    const home = scratch();
    const send = join(home, 'Send');
    const inside = join(send, 'In');
    mkdirSync(inside, { recursive: true, mode: 0o700 });
    chmodSync(send, 0o700);
    chmodSync(inside, 0o700);
    expect(await inboxFolderProblem({ realpath: send, home, sendFolders: [send] })).toBe(
      'send_folder',
    );
    expect(await inboxFolderProblem({ realpath: inside, home, sendFolders: [send] })).toBe(
      'send_folder',
    );
    expect(await inboxFolderProblem({ realpath: send, home, sendFolders: [inside] })).toBe(
      'send_folder',
    );
  });

  it('refuses OS and app folders (IR SEC L1): Library, System, Applications, AppData, Program Files', async () => {
    const home = scratch();
    const lib = join(home, 'Library', 'Inbox');
    mkdirSync(lib, { recursive: true, mode: 0o700 });
    chmodSync(join(home, 'Library'), 0o700);
    chmodSync(lib, 0o700);
    const stat = lstatSync(lib);
    const darwin = (realpath: string) =>
      inboxFolderProblem({ realpath, home, sendFolders: [], stat, platform: 'darwin' });
    expect(await darwin(join(home, 'Library'))).toBe('os_folder');
    expect(await darwin(lib)).toBe('os_folder');
    for (const p of ['/Library/In', '/System/In', '/Applications/In', '/Applications']) {
      expect(await darwin(p), p).toBe('os_folder');
    }
    const win = (realpath: string) =>
      inboxFolderProblem({
        realpath,
        home: 'C:\\Users\\ana',
        sendFolders: [],
        stat,
        platform: 'win32',
      });
    for (const p of [
      'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
      'C:\\Users\\ana\\AppData\\Local\\In',
      'C:\\Program Files\\In',
      'C:\\Program Files (x86)\\In',
      'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp',
      'C:\\Windows\\Temp',
    ]) {
      expect(await win(p), p).toBe('os_folder');
    }
    expect(await win('C:\\Users\\ana\\Documents\\Inbox')).toBeUndefined();
  });

  it('refuses a file and a missing path', async () => {
    const home = scratch();
    const file = join(home, 'f');
    writeFileSync(file, 'x');
    expect(await inboxFolderProblem({ realpath: file, home, sendFolders: [] })).toBe(
      'not_a_folder',
    );
    expect(await inboxFolderProblem({ realpath: join(home, 'none'), home, sendFolders: [] })).toBe(
      'not_a_folder',
    );
  });
});

describe('openInboxDir: the held directory (04 §4.1)', () => {
  it.skipIf(process.platform === 'win32')(
    'a folder swapped for a link or another directory after the check is detected',
    async () => {
      const root = scratch();
      const inbox = join(root, 'Inbox');
      mkdirSync(inbox, { mode: 0o700 });
      const dir = await openInboxDir(inbox, lstatSync(inbox));
      expect(dir).toBeDefined();
      expect(await dir?.stillSame()).toBe(true);
      // Swap: the original moves away and a symlink to elsewhere takes its name.
      const elsewhere = join(root, 'Elsewhere');
      mkdirSync(elsewhere, { mode: 0o700 });
      renameSync(inbox, join(root, 'Moved'));
      symlinkSync(elsewhere, inbox);
      expect(await dir?.stillSame()).toBe(false);
      await dir?.close();
    },
  );

  it.skipIf(process.platform === 'win32')('a link at the folder path is never opened', async () => {
    const root = scratch();
    const real = join(root, 'Real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, 'Link');
    symlinkSync(real, link);
    expect(await openInboxDir(link, lstatSync(real))).toBeUndefined();
  });
});

describe('quarantineMark (04 §4.1)', () => {
  it('the macOS value: flags 0081, hex time, AgentLink, a random UUID; no link', () => {
    const v = quarantineValue(0x6543_2100);
    expect(v).toMatch(
      /^0081;65432100;AgentLink;[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
    expect(v).not.toMatch(/https?:|\/\//);
    expect(ZONE_IDENTIFIER).toBe('[ZoneTransfer]\r\nZoneId=3\r\n');
  });

  it('Linux has no common mark: unsupported (accepted residual)', async () => {
    expect(await quarantineMark('/x', { platform: 'linux' })).toBe('unsupported');
  });

  it('macOS: sets with -s -w, reads back with -s -p; a failure or a different value is failed', async () => {
    const calls: (readonly string[])[] = [];
    let stored = '';
    const ok = await quarantineMark('/inbox/.agentlink-partial-x', {
      platform: 'darwin',
      xattr: (args) => {
        calls.push(args);
        if (args[1] === '-w') stored = args[3] as string;
        return Promise.resolve(args[1] === '-p' ? `${stored}\n` : '');
      },
    });
    expect(ok).toBe('marked');
    expect(calls[0]?.slice(0, 3)).toEqual(['-s', '-w', MACOS_QUARANTINE_ATTR]);
    expect(calls[1]?.slice(0, 3)).toEqual(['-s', '-p', MACOS_QUARANTINE_ATTR]);
    expect(
      await quarantineMark('/x', {
        platform: 'darwin',
        xattr: () => Promise.reject(new Error('EPERM')),
      }),
    ).toBe('failed');
    expect(
      await quarantineMark('/x', { platform: 'darwin', xattr: () => Promise.resolve('other') }),
    ).toBe('failed');
  });

  it.runIf(process.platform === 'darwin')(
    'macOS for real: the file carries com.apple.quarantine',
    async () => {
      const root = scratch();
      const file = join(root, 'f.bin');
      writeFileSync(file, 'x', { mode: 0o600 });
      expect(await quarantineMark(file)).toBe('marked');
      const value = execFileSync('/usr/bin/xattr', ['-p', MACOS_QUARANTINE_ATTR, file], {
        encoding: 'utf8',
      }).trim();
      expect(value).toMatch(/^0081;[0-9a-f]+;AgentLink;/);
      expect(lstatSync(file).mode & 0o111).toBe(0); // never executable
    },
  );
});
