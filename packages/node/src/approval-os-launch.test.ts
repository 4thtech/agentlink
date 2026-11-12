// R1-SEC-05 (04 §2.8 "other OS users", 08 §1 "in memory only"): the one-shot session link never
// reaches the opener's argv, which other OS users can read (`ps`, /proc/<pid>/cmdline). The OS
// opener writes a private launch page (0600, in a 0700 folder in the owner's data folder) that sends
// the browser on to the link, and hands the OS opener only that file's path.
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

interface Call {
  file: string;
  args: readonly string[];
}

function launchSeams(platform: NodeJS.Platform, over: Partial<OsSeams> = {}) {
  const calls: Call[] = [];
  const pages: string[] = [];
  const seams = {
    platform,
    env: {},
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
    writeLaunchFile: (html: string) => {
      pages.push(html);
      return Promise.resolve(
        platform === 'win32'
          ? 'C:\\Users\\me\\.agentlink\\open\\abc.html'
          : '/home/me/.agentlink/open/abc.html',
      );
    },
    ...over,
  } as unknown as OsSeams;
  return { seams, calls, pages };
}

describe('the session link is never in the opener argv (R1-SEC-05)', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'on %s opens a launch file; no argument carries the link or its token',
    async (p) => {
      const { seams, calls, pages } = launchSeams(p);
      expect(await browserOpenerWith(seams)(LINK)).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.args.join(' ')).not.toContain(TOKEN);
        expect(call.args.join(' ')).not.toContain('localhost');
      }
      expect(calls[0]?.args.at(-1)).toMatch(/abc\.html$/);
      expect(pages).toHaveLength(1);
      const page = pages[0] ?? '';
      expect(page).toContain(`<meta http-equiv="refresh" content="0;url=${LINK}">`);
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
    },
  );

  it('on win32 hands a percent-encoded file URL, so a home folder with spaces stays one argument', async () => {
    const { seams, calls } = launchSeams('win32', {
      writeLaunchFile: () => Promise.resolve('C:\\Users\\Ana Novak\\.agentlink\\open\\abc.html'),
    } as unknown as Partial<OsSeams>);
    expect(await browserOpenerWith(seams)(LINK)).toBe(true);
    expect(calls[0]?.args).toEqual([
      'url.dll,FileProtocolHandler',
      'file:///C:/Users/Ana%20Novak/.agentlink/open/abc.html',
    ]);
  });

  it('opens nothing when the launch file cannot be written (never falls back to argv)', async () => {
    const { seams, calls } = launchSeams('darwin', {
      writeLaunchFile: () => Promise.resolve(undefined),
    } as unknown as Partial<OsSeams>);
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
      const { seams, calls, pages } = launchSeams('linux');
      expect(await browserOpenerWith(seams)(bad), bad).toBe(false);
      expect(calls).toHaveLength(0);
      expect(pages).toHaveLength(0);
    }
  });
});

describe.skipIf(process.platform === 'win32')('the private launch file (R1-SEC-05)', () => {
  const write = (
    os as unknown as {
      writePrivateLaunchFile?: (dir: string, html: string) => Promise<string | undefined>;
    }
  ).writePrivateLaunchFile;

  it('is 0600 in a 0700 folder, under a random name, and stale ones are swept', async () => {
    expect(write).toBeTypeOf('function');
    const home = mkdtempSync(join(tmpdir(), 'al-launch-'));
    const dir = join(home, '.agentlink', 'open');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const stale = join(dir, 'old.html');
    writeFileSync(stale, 'x');
    utimesSync(stale, new Date(0), new Date(0));
    const a = await write?.(dir, '<p>a</p>');
    const b = await write?.(dir, '<p>b</p>');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(statSync(a as string).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).not.toContain('old.html');
  });

  it('refuses a launch folder that is a symlink', async () => {
    expect(write).toBeTypeOf('function');
    const home = mkdtempSync(join(tmpdir(), 'al-launch-'));
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(home, '.agentlink'));
    symlinkSync(elsewhere, join(home, '.agentlink', 'open'));
    expect(await write?.(join(home, '.agentlink', 'open'), '<p>x</p>')).toBeUndefined();
    expect(readdirSync(elsewhere)).toHaveLength(0);
  });
});
