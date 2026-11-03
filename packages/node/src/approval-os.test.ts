// M1-11a-b (IR-M1-11a-b-1 L-2, L-4): the approval UI's OS opener and notifier run a fixed program
// by absolute path through execFile with `shell: false`, the url as its own argument, and never
// resolve a program through PATH. A missing program is not run (the opener resolves false).
import { describe, expect, it } from 'vitest';
import {
  OS_PROGRAMS,
  browserOpenerWith,
  fileRevealerWith,
  notifierWith,
  type OsSeams,
} from './approval-os.js';

const URL_ = 'http://localhost:47321/approve/apr_AAAAAAAAAAAAAAAAAAAAAA?t=abc;rm -rf ~ $(x)';
const ALLOWED = new Set<string>([
  ...Object.values(OS_PROGRAMS),
  'D:\\Windows\\explorer.exe',
  'D:\\Windows\\System32\\rundll32.exe',
]);

interface Call {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function seams(
  platform: NodeJS.Platform,
  over: Partial<OsSeams> = {},
): { seams: OsSeams; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    seams: {
      platform,
      env: {},
      executable: () => true,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args: [...args], options: { ...options } });
        callback(null);
      },
      ...over,
    },
  };
}

describe('the browser opener (L-2, L-4)', () => {
  it.each([
    ['darwin', '/usr/bin/open'],
    ['linux', '/usr/bin/xdg-open'],
    ['freebsd', '/usr/bin/xdg-open'],
  ] as const)('on %s runs %s with shell false and the url as one argument', async (p, program) => {
    const { seams: s, calls } = seams(p);
    expect(await browserOpenerWith(s)(URL_)).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.file).toBe(program);
    expect(ALLOWED.has(call.file)).toBe(true);
    expect(call.args).toEqual([URL_]);
    expect(call.options['shell']).toBe(false);
  });

  // F40 (Windows 11, 0.4.10): explorer.exe <url> exits 1 whether or not a browser opened, so a
  // silent failure read as "opened". rundll32 url.dll,FileProtocolHandler hands the url to the
  // default browser and reports a failure to start; explorer.exe stays the fallback. Never cmd.exe
  // or `start` (their command line would parse the url).
  it('on win32 runs System32\\rundll32.exe url.dll,FileProtocolHandler <url>: shell false, one url argument', async () => {
    const { seams: s, calls } = seams('win32');
    expect(await browserOpenerWith(s)(URL_)).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.file).toBe('C:\\Windows\\System32\\rundll32.exe');
    expect(ALLOWED.has(call.file)).toBe(true);
    expect(call.args).toEqual(['url.dll,FileProtocolHandler', URL_]);
    expect(call.options['shell']).toBe(false);
    expect(call.options['windowsHide']).toBe(true);
    expect(call.options['windowsVerbatimArguments']).toBeUndefined();
    expect(call.options['timeout']).toBeGreaterThan(0);
  });

  it('on win32 falls back to explorer.exe when rundll32 is missing or fails, and never to cmd', async () => {
    const missing = seams('win32', { executable: (path) => !path.endsWith('rundll32.exe') });
    expect(await browserOpenerWith(missing.seams)(URL_)).toBe(true);
    expect(missing.calls.map((c) => c.file)).toEqual(['C:\\Windows\\explorer.exe']);
    expect(missing.calls[0]?.args).toEqual([URL_]);

    const calls: Call[] = [];
    const failing = seams('win32', {
      execFile: (file, args, options, callback) => {
        calls.push({ file, args: [...args], options: { ...options } });
        callback(file.endsWith('rundll32.exe') ? Object.assign(new Error('x'), { code: 1 }) : null);
      },
    });
    expect(await browserOpenerWith(failing.seams)(URL_)).toBe(true);
    expect(calls.map((c) => c.file)).toEqual([
      'C:\\Windows\\System32\\rundll32.exe',
      'C:\\Windows\\explorer.exe',
    ]);
    for (const c of calls) {
      expect(c.file.toLowerCase()).not.toMatch(/cmd\.exe|powershell/);
      expect(c.args).not.toContain('start');
      expect(c.options['shell']).toBe(false);
    }
  });

  it('on win32 resolves false when neither rundll32 nor explorer is there', async () => {
    const { seams: s, calls } = seams('win32', { executable: () => false });
    expect(await browserOpenerWith(s)(URL_)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uses SystemRoot only when it is a plain drive:\\Windows', async () => {
    for (const [root, program] of [
      ['D:\\Windows', 'D:\\Windows\\System32\\rundll32.exe'],
      ['C:\\Users\\me\\bin', 'C:\\Windows\\System32\\rundll32.exe'],
      ['\\\\evil\\share\\Windows', 'C:\\Windows\\System32\\rundll32.exe'],
    ] as const) {
      const { seams: s, calls } = seams('win32', { env: { SystemRoot: root } });
      await browserOpenerWith(s)(URL_);
      expect(calls[0]?.file, root).toBe(program);
    }
  });

  it('never runs a program through PATH: a missing program is not run and resolves false', async () => {
    const checked: string[] = [];
    const { seams: s, calls } = seams('darwin', {
      env: { PATH: '/tmp/evil' },
      executable: (path) => {
        checked.push(path);
        return false;
      },
    });
    expect(await browserOpenerWith(s)(URL_)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(checked).toEqual(['/usr/bin/open']);
  });

  it('resolves false when the program fails or throws', async () => {
    const failing = seams('linux', {
      execFile: (_f, _a, _o, callback) => callback(Object.assign(new Error('x'), { code: 1 })),
    });
    expect(await browserOpenerWith(failing.seams)(URL_)).toBe(false);
    const throwing = seams('linux', {
      execFile: () => {
        throw new Error('spawn');
      },
    });
    expect(await browserOpenerWith(throwing.seams)(URL_)).toBe(false);
  });
});

describe('the notifier (L-2, L-4)', () => {
  it('runs osascript and notify-send by absolute path with shell false', async () => {
    for (const [p, program] of [
      ['darwin', '/usr/bin/osascript'],
      ['linux', '/usr/bin/notify-send'],
    ] as const) {
      const { seams: s, calls } = seams(p);
      expect(await notifierWith(s)(['AgentLink', 'An approval is waiting for you.'])).toBe(true);
      expect(calls[0]?.file).toBe(program);
      expect(calls[0]?.options['shell']).toBe(false);
    }
    const win = seams('win32');
    expect(await notifierWith(win.seams)(['AgentLink', 'x'])).toBe(false);
    expect(win.calls).toHaveLength(0);
  });
});

// MSG-FILES-IO-h: Show in Finder reveals one checked file with the OS file manager. A fixed program
// by absolute path, shell false, the checked path as one argument (never joined into a command).
describe('the file revealer (MSG-FILES-IO-h)', () => {
  const FILE = '/Users/me/AgentLink/Inbox/a b;$(rm -rf ~) `x`.pdf';
  const FOLDER = '/Users/me/AgentLink/Inbox';

  it.each([
    ['darwin', '/usr/bin/open', ['-R', FILE]],
    ['linux', '/usr/bin/xdg-open', [FOLDER]],
    ['freebsd', '/usr/bin/xdg-open', [FOLDER]],
  ] as const)(
    'on %s runs %s with shell false and the path as its own argument',
    async (p, program, args) => {
      const { seams: s, calls } = seams(p);
      expect(await fileRevealerWith(s)(FILE, FOLDER)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.file).toBe(program);
      expect(calls[0]?.args).toEqual(args);
      expect(calls[0]?.options['shell']).toBe(false);
    },
  );

  it('on Windows runs explorer.exe /select,"<path>" verbatim, so the path stays one argument (any exit code)', async () => {
    // CHORE-MAIN-NODEOS-040: explorer.exe parses its own command line and splits on commas, so the
    // path is quoted by us and passed verbatim. A `"` cannot occur in a Windows path (and the saved
    // name went through sanitizeFileName), so the quotes cannot be closed early.
    const file = 'C:\\Users\\me\\AgentLink\\Inbox\\a b, & c;(1).pdf';
    const { seams: s, calls } = seams('win32', {
      execFile: (file_, args, options, callback) => {
        calls.push({ file: file_, args: [...args], options: { ...options } });
        callback(Object.assign(new Error('exit 1'), { code: 1 }));
      },
    });
    expect(await fileRevealerWith(s)(file, 'C:\\Users\\me\\AgentLink\\Inbox')).toBe(true);
    expect(calls[0]?.file).toBe('C:\\Windows\\explorer.exe');
    expect(calls[0]?.args).toEqual([`/select,"${file}"`]);
    expect(calls[0]?.options['shell']).toBe(false);
    expect(calls[0]?.options['windowsVerbatimArguments']).toBe(true);
  });

  it('the verbatim Windows arguments are used only for the revealer', async () => {
    const { seams: s, calls } = seams('win32');
    expect(await browserOpenerWith(s)(URL_)).toBe(true);
    expect(calls[0]?.options['windowsVerbatimArguments']).toBeUndefined();
    const mac = seams('darwin');
    expect(await fileRevealerWith(mac.seams)(FILE, FOLDER)).toBe(true);
    expect(mac.calls[0]?.options['windowsVerbatimArguments']).toBeUndefined();
  });

  it('never runs for a path that is not absolute, or that could read as an option', async () => {
    for (const [p, file, folder] of [
      ['darwin', 'Inbox/x.pdf', '/Users/me/Inbox'],
      ['darwin', '-n', '/Users/me/Inbox'],
      ['linux', '/home/me/Inbox/x.pdf', '--help'],
      ['win32', '/select,C:\\x', 'C:\\Inbox'],
      ['win32', 'C:\\Inbox\\a" /select,"C:\\x.pdf', 'C:\\Inbox'],
      ['win32', 'C:\\Inbox\\a.pdf', 'C:\\In"box'],
      ['darwin', '/Users/me/Inbox/x\u0000.pdf', '/Users/me/Inbox'],
    ] as const) {
      const { seams: s, calls } = seams(p);
      expect(await fileRevealerWith(s)(file, folder), file).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it('a missing program is not run and resolves false', async () => {
    const { seams: s, calls } = seams('darwin', { executable: () => false });
    expect(await fileRevealerWith(s)(FILE, FOLDER)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
