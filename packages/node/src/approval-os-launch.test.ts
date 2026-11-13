// R1-SEC-05 (04 §2.8 "other OS users", 08 §1 "in memory only"): the one-shot session link never
// reaches the opener's argv, which other OS users can read (`ps`, /proc/<pid>/cmdline). The OS
// opener writes a private launch page (0600, in a 0700 folder in the owner's data folder) that sends
// the browser on to the link, and hands only that file to the owner's DEFAULT WEB BROWSER (R2-10:
// never the OS's `.html` handler, often an editor). When the default browser cannot be found, the
// opener falls back to the link itself (the pre-0.5.1 behaviour, a residual in 04 §2.8).
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as os from './approval-os.js';
import { browserOpenerWith, type OsSeams } from './approval-os.js';

const TOKEN = 'A'.repeat(43);
const LINK = `http://localhost:47321/settings/home?t=${TOKEN}`;
const MAC_FILE = '/Users/me/.agentlink/open/abc.html';
const LINUX_FILE = '/home/me/AgentLink/open/abc.html';
const WIN_FILE = 'C:\\Users\\Ana Novak\\.agentlink\\open\\abc.html';
const WIN_URL = 'file:///C:/Users/Ana%20Novak/.agentlink/open/abc.html';
const PLIST =
  '/Users/me/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';
const REG = 'C:\\Windows\\System32\\reg.exe';

interface Call {
  file: string;
  args: readonly string[];
}

const chromePlist = JSON.stringify({
  LSHandlers: [
    { LSHandlerContentType: 'public.html', LSHandlerRoleAll: 'com.microsoft.vscode' },
    { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' },
    { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.google.chrome' },
  ],
});

/** Answers of the read-only commands the opener runs to find the default browser. */
type Outputs = Record<string, string | undefined>;

function launchSeams(
  platform: NodeJS.Platform,
  options: {
    outputs?: Outputs;
    files?: Record<string, string>;
    over?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const pages: string[] = [];
  const outputs = options.outputs ?? {};
  const files = options.files ?? {};
  const seams = {
    platform,
    env: platform === 'linux' ? { XDG_DATA_DIRS: '/usr/share' } : {},
    home:
      platform === 'win32'
        ? 'C:\\Users\\Ana Novak'
        : platform === 'darwin'
          ? '/Users/me'
          : '/home/me',
    executable: () => true,
    execFile: (
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: null) => void,
    ) => {
      calls.push({ file, args: [...args] });
      callback(null);
    },
    readOutput: (file: string, args: readonly string[]) => {
      const key = [file, ...args].join(' ');
      reads.push(key);
      return Promise.resolve(outputs[key]);
    },
    readText: (path: string) => Promise.resolve(files[path]),
    exists: (path: string) => Promise.resolve(path in files || path === PLIST),
    writeLaunchFile: (html: string) => {
      pages.push(html);
      return Promise.resolve(
        platform === 'win32' ? WIN_FILE : platform === 'darwin' ? MAC_FILE : LINUX_FILE,
      );
    },
    ...options.over,
  } as unknown as OsSeams;
  return { seams, calls, pages, reads };
}

const macChrome = { [`/usr/bin/plutil -convert json -o - ${PLIST}`]: chromePlist };
const winChrome = {
  [`${REG} query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice /v ProgId`]:
    '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n',
  [`${REG} query HKCR\\ChromeHTML\\shell\\open\\command /ve`]:
    '\r\nHKEY_CLASSES_ROOT\\ChromeHTML\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1\r\n',
};
const linuxFirefox = {
  outputs: { '/usr/bin/xdg-settings get default-web-browser': 'firefox_firefox.desktop\n' },
  files: {
    '/var/lib/snapd/desktop/applications/firefox_firefox.desktop':
      '[Desktop Entry]\nName=Firefox\nExec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u\n[Desktop Action new-window]\nExec=/snap/bin/firefox --new-window %u\n',
  },
};

function noToken(calls: Call[]): void {
  for (const call of calls) {
    expect(call.args.join(' ')).not.toContain(TOKEN);
    expect(call.args.join(' ')).not.toContain('localhost');
  }
}

describe('the launch file opens in the default web browser (R1-SEC-05, R2-10)', () => {
  it('macOS: the http handler from LaunchServices, `open -b <bundle> <file>`', async () => {
    const { seams, calls, pages } = launchSeams('darwin', { outputs: macChrome });
    expect(await browserOpenerWith(seams)(LINK)).toBe(true);
    expect(calls).toEqual([{ file: '/usr/bin/open', args: ['-b', 'com.google.chrome', MAC_FILE] }]);
    noToken(calls);
    const page = pages[0] ?? '';
    expect(page).toContain(`<meta http-equiv="refresh" content="0;url=${LINK}">`);
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('macOS: no http entry, or no LaunchServices file, means Safari', async () => {
    const empty = launchSeams('darwin', {
      outputs: { [`/usr/bin/plutil -convert json -o - ${PLIST}`]: '{"LSHandlers":[]}' },
    });
    expect(await browserOpenerWith(empty.seams)(LINK)).toBe(true);
    expect(empty.calls[0]?.args).toEqual(['-b', 'com.apple.Safari', MAC_FILE]);
    const none = launchSeams('darwin', { over: { exists: () => Promise.resolve(false) } });
    expect(await browserOpenerWith(none.seams)(LINK)).toBe(true);
    expect(none.calls[0]?.args).toEqual(['-b', 'com.apple.Safari', MAC_FILE]);
  });

  it('Windows: UserChoice ProgId, its open command, the file URL in place of %1', async () => {
    const { seams, calls } = launchSeams('win32', { outputs: winChrome });
    expect(await browserOpenerWith(seams)(LINK)).toBe(true);
    expect(calls).toEqual([
      {
        file: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--single-argument', WIN_URL],
      },
    ]);
    noToken(calls);
  });

  it('Linux: xdg-settings, the .desktop Exec line, the launch file in place of %u', async () => {
    const { seams, calls } = launchSeams('linux', linuxFirefox);
    expect(await browserOpenerWith(seams)(LINK)).toBe(true);
    expect(calls).toEqual([
      {
        file: '/usr/bin/env',
        args: [
          'BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop',
          '/snap/bin/firefox',
          LINUX_FILE,
        ],
      },
    ]);
    noToken(calls);
  });

  it.each([
    ['darwin', { [`/usr/bin/plutil -convert json -o - ${PLIST}`]: undefined }],
    [
      'darwin',
      {
        [`/usr/bin/plutil -convert json -o - ${PLIST}`]: JSON.stringify({
          LSHandlers: [{ LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'x;rm -rf' }],
        }),
      },
    ],
    ['win32', {}],
    [
      'win32',
      {
        ...winChrome,
        [`${REG} query HKCR\\ChromeHTML\\shell\\open\\command /ve`]:
          '    (Default)    REG_SZ    cmd.exe /c start %1',
      },
    ],
    ['linux', {}],
    ['linux', { '/usr/bin/xdg-settings get default-web-browser': '../../evil.desktop' }],
  ] as const)(
    'on %s with no usable default browser falls back to the link (pre-0.5.1 opener)',
    async (platform, outputs) => {
      const { seams, calls, pages } = launchSeams(platform, { outputs: outputs as Outputs });
      expect(await browserOpenerWith(seams)(LINK)).toBe(true);
      expect(pages).toHaveLength(0);
      const expected =
        platform === 'darwin'
          ? { file: '/usr/bin/open', args: [LINK] }
          : platform === 'win32'
            ? {
                file: 'C:\\Windows\\System32\\rundll32.exe',
                args: ['url.dll,FileProtocolHandler', LINK],
              }
            : { file: '/usr/bin/xdg-open', args: [LINK] };
      expect(calls).toEqual([expected]);
    },
  );

  it('opens nothing when the launch file cannot be written', async () => {
    const { seams, calls } = launchSeams('darwin', {
      outputs: macChrome,
      over: { writeLaunchFile: () => Promise.resolve(undefined) },
    });
    expect(await browserOpenerWith(seams)(LINK)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("writes and opens nothing for a link that is not this server's own session link", async () => {
    for (const bad of [
      'https://evil.example/?t=x',
      'http://localhost:47321/?t=a"><script>',
      `http://127.0.0.1:47321/?t=${TOKEN}`,
      'file:///etc/passwd',
      'http://localhost:47321/approve/x?t=abc;rm -rf ~ $(x)',
    ]) {
      const { seams, calls, pages } = launchSeams('linux', linuxFirefox);
      expect(await browserOpenerWith(seams)(bad), bad).toBe(false);
      expect(calls).toHaveLength(0);
      expect(pages).toHaveLength(0);
    }
  });
});

// Snap-packaged browsers (Ubuntu's default Firefox) cannot read hidden folders in the home folder,
// so on Linux the launch folder is the visible `~/AgentLink/open`.
describe('the launch folder per platform (R1-SEC-05)', () => {
  it.each([
    ['darwin', join('/h', '.agentlink', 'open')],
    ['win32', join('/h', '.agentlink', 'open')],
    ['linux', join('/h', 'AgentLink', 'open')],
    ['freebsd', join('/h', 'AgentLink', 'open')],
  ] as const)('on %s it is %s', (platform, expected) => {
    expect(os.launchFolder('/h', platform)).toBe(expected);
  });

  it('on Linux no segment under home is hidden', () => {
    const rel = os.launchFolder('/h', 'linux').slice('/h/'.length);
    for (const part of rel.split('/')) expect(part.startsWith('.')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the private launch file (R1-SEC-05)', () => {
  const write = os.writePrivateLaunchFile;

  it('is 0600 in a 0700 folder, under a random name, and stale launch files are swept', async () => {
    const home = mkdtempSync(join(tmpdir(), 'al-launch-'));
    const dir = join(home, '.agentlink', 'open');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const stale = join(dir, `${'ab'.repeat(16)}.html`);
    writeFileSync(stale, 'x');
    utimesSync(stale, new Date(0), new Date(0));
    const a = await write(dir, '<p>a</p>');
    const b = await write(dir, '<p>b</p>');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(statSync(a as string).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).not.toContain(`${'ab'.repeat(16)}.html`);
  });

  // R2-11: the sweep removes only launch files (32 hex characters + .html), never anything else.
  it('never sweeps a file that is not a launch file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'al-launch-'));
    const dir = join(home, 'AgentLink', 'open');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of [
      'notes.txt',
      'old.html',
      `${'AB'.repeat(16)}.html`,
      `${'ab'.repeat(16)}.htm`,
    ]) {
      writeFileSync(join(dir, name), 'x');
      utimesSync(join(dir, name), new Date(0), new Date(0));
    }
    await write(dir, '<p>a</p>');
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining([
        'notes.txt',
        'old.html',
        `${'AB'.repeat(16)}.html`,
        `${'ab'.repeat(16)}.htm`,
      ]),
    );
  });

  it('refuses a launch folder that is a symlink', async () => {
    const home = mkdtempSync(join(tmpdir(), 'al-launch-'));
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(home, '.agentlink'));
    symlinkSync(elsewhere, join(home, '.agentlink', 'open'));
    expect(await write(join(home, '.agentlink', 'open'), '<p>x</p>')).toBeUndefined();
    expect(readdirSync(elsewhere)).toHaveLength(0);
  });
});
