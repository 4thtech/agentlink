// M1-11a-b (IR-M1-11a-b-1 L-2, L-4): the approval UI's OS opener and notifier run a fixed program
// by absolute path through execFile with `shell: false`, the url as its own argument, and never
// resolve a program through PATH. A missing program is not run (the opener resolves false).
import { describe, expect, it } from 'vitest';
import { OS_PROGRAMS, browserOpenerWith, notifierWith, type OsSeams } from './approval-os.js';

const URL_ = 'http://localhost:47321/approve/apr_AAAAAAAAAAAAAAAAAAAAAA?t=abc;rm -rf ~ $(x)';
const ALLOWED = new Set<string>([...Object.values(OS_PROGRAMS), 'D:\\Windows\\explorer.exe']);

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
    ['win32', 'C:\\Windows\\explorer.exe'],
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

  it('uses SystemRoot only when it is a plain drive:\\Windows', async () => {
    for (const [root, program] of [
      ['D:\\Windows', 'D:\\Windows\\explorer.exe'],
      ['C:\\Users\\me\\bin', 'C:\\Windows\\explorer.exe'],
      ['\\\\evil\\share\\Windows', 'C:\\Windows\\explorer.exe'],
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
