// The shell's startup order and wiring (src/main/main.ts) with a fake Electron: each forbidden
// switch → exit, no window, no core; the session link only from the pipe; deep links only through
// the (WP-D9) handler; quit stops the core.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_LOG_FILE } from '../../src/main/core-log.js';
import { STATUS_ACTION_URLS, statusPageUrl } from '../../src/main/status-page.js';
import {
  LAUNCH_REFUSED_EXIT,
  readPreview,
  resourcePaths,
  runShell,
  type ShellProcess,
} from '../../src/main/main.js';
import { WINDOW_PARTITION } from '../../src/main/security.js';
import {
  FakeBrowserWindow,
  FakeEvent,
  FakeWebContents,
  FakeTimers,
  FakeTray,
  SESSION_URL,
  fakeElectron,
  fakeSpawn,
  readyLine,
} from './fakes.js';

const EXE = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';
const RES = '/Applications/AgentLink.app/Contents/Resources';
const SHORT = `2.${'A'.repeat(42)}A`;
const INVITE = `https://agentlink.4thtech.io/i#${SHORT}`;

const logDirs: string[] = [];
afterEach(() => {
  for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(args: string[] = [], over: Partial<ShellProcess> = {}) {
  const logDir = join(mkdtempSync(join(tmpdir(), 'agentlink-main-')), 'Logs', 'AgentLink');
  logDirs.push(join(logDir, '..', '..'));
  const electron = fakeElectron();
  const { spawn, children } = fakeSpawn();
  const proc: ShellProcess = {
    argv: [EXE, ...args],
    execArgv: [],
    env: { HOME: '/Users/x', PATH: '/usr/bin' },
    platform: 'darwin',
    execPath: EXE,
    resourcesPath: RES,
    homeDir: '/Users/x',
    tmpDir: '/var/folders/ab/T',
    writable: () => true,
    exists: () => true,
    spawn,
    timers: new FakeTimers(),
    preview: null,
    logDir,
    ...over,
  };
  return { electron, children, proc };
}

/** The window's webContents emits a navigation to `url`; true when it was blocked. */
const click = (url: string): boolean =>
  FakeBrowserWindow.created[0]?.webContents.navigate('will-navigate', url) ?? false;
const lastPage = (): string | undefined => FakeBrowserWindow.created[0]?.loaded.at(-1);

const SWITCHES = [
  '--remote-debugging-port=9222',
  '--remote-debugging-pipe',
  '--inspect',
  '--inspect-brk=1',
  '--js-flags=--expose-gc',
  '--proxy-server=evil.example:1',
  '--disable-web-security',
  '--host-rules=MAP * evil.example',
  '--user-data-dir=/tmp/x',
  '--load-extension=/tmp/x',
  '--enable-logging',
  '--anything-else',
];

describe('runShell launch lockdown', () => {
  it.each(SWITCHES)('%s → exit, no window, no core, no lock', async (arg) => {
    const { electron, children, proc } = setup([arg]);
    expect(await runShell(electron, proc)).toBe('refused');
    expect(electron.app.exitCode).toBe(LAUNCH_REFUSED_EXIT);
    expect(electron.app.order).toEqual([`exit:${LAUNCH_REFUSED_EXIT}`]);
    expect(FakeBrowserWindow.created).toHaveLength(0);
    expect(children).toHaveLength(0);
  });

  it('a switch on Chromium’s command line by another route → exit', async () => {
    const { electron, children, proc } = setup();
    electron.app.switches.add('remote-debugging-port');
    expect(await runShell(electron, proc)).toBe('refused');
    expect(electron.app.exitCode).toBe(LAUNCH_REFUSED_EXIT);
    expect(children).toHaveLength(0);
  });

  it('a forbidden environment variable → exit', async () => {
    const { electron, proc } = setup([], { env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(await runShell(electron, proc)).toBe('refused');
  });

  it('a crafted deep link that adds a switch → exit', async () => {
    const { electron, proc } = setup(['--', 'agentlink://join#x', '--remote-debugging-port=1']);
    expect(await runShell(electron, proc)).toBe('refused');
  });

  it('--user-data-dir is accepted only with preview settings', async () => {
    const preview = { node: undefined, hostScript: undefined };
    const ok = setup(['--user-data-dir=/tmp/h/ud'], { preview });
    ok.electron.app.switches.add('user-data-dir');
    expect(await runShell(ok.electron, ok.proc)).toBe('running');
    const no = setup(['--user-data-dir=/tmp/h/ud']);
    expect(await runShell(no.electron, no.proc)).toBe('refused');
  });
});

describe('runShell startup', () => {
  it('enables the sandbox and takes the single-instance lock with the checked deep link only', async () => {
    const { electron, proc } = setup(['--', 'agentlink://join#abc']);
    expect(await runShell(electron, proc)).toBe('running');
    expect(electron.app.sandboxEnabled).toBe(true);
    expect(electron.app.lockData).toEqual({ deepLink: 'agentlink://join#abc' });
    expect(electron.app.order.slice(0, 3)).toEqual(['sandbox', 'lock', 'ready']);
  });

  it('a second instance exits without a window or a core', async () => {
    const { electron, children, proc } = setup();
    electron.app.lockGranted = false;
    expect(await runShell(electron, proc)).toBe('second-instance');
    expect(FakeBrowserWindow.created).toHaveLength(0);
    expect(children).toHaveLength(0);
  });

  it('refuses a translocated location before starting the core', async () => {
    const translocated =
      '/private/var/folders/ab/T/AppTranslocation/1/d/AgentLink.app/Contents/MacOS/AgentLink';
    const { electron, children, proc } = setup([], { execPath: translocated });
    electron.dialog.responses = [1];
    expect(await runShell(electron, proc)).toBe('location');
    expect(children).toHaveLength(0);
    expect(electron.dialog.shown).toHaveLength(1);
  });

  it('starts the bundled core and hardens the in-memory session', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    expect(children).toHaveLength(1);
    expect(children[0]?.command).toBe(resourcePaths(RES, 'darwin').node);
    expect(children[0]?.args).toEqual([resourcePaths(RES, 'darwin').hostScript]);
    const session = electron.sessions.get(WINDOW_PARTITION);
    expect(session?.permissionRequest).not.toBeNull();
    expect(session?.beforeRequest).not.toBeNull();
    expect(FakeTray.created).toHaveLength(1);
  });

  it('shows a window with the local starting page at once, before the core is ready', async () => {
    const { electron, proc } = setup();
    await runShell(electron, proc);
    expect(FakeBrowserWindow.created).toHaveLength(1);
    expect(FakeBrowserWindow.created[0]?.loaded).toEqual([statusPageUrl('starting')]);
    expect(FakeBrowserWindow.created[0]?.visible).toBe(true);
  });

  it('always creates the tray: built-in image when the icon file is missing', async () => {
    const { electron, proc } = setup([], { exists: (path) => !path.endsWith('.png') });
    await runShell(electron, proc);
    expect(FakeTray.created).toHaveLength(1);
    expect(typeof FakeTray.created[0]?.icon).not.toBe('string');
  });

  it('missing core files → the fixed page, no core', async () => {
    const { electron, children, proc } = setup([], { exists: (path) => !path.includes('node') });
    await runShell(electron, proc);
    expect(children).toHaveLength(0);
    expect(lastPage()).toBe(statusPageUrl('missing_files'));
  });

  it('started from an AI app → the fixed page, no core (the core keeps its own guard)', async () => {
    const { electron, children, proc } = setup([], {
      env: { HOME: '/Users/x', PATH: '/usr/bin', CLAUDECODE: '1' },
    });
    await runShell(electron, proc);
    expect(children).toHaveLength(0);
    expect(lastPage()).toBe(statusPageUrl('ai_app'));
    expect(click(STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(children).toHaveLength(0);
    expect(lastPage()).toBe(statusPageUrl('ai_app'));
  });

  it('five quick exits before ready → the "exited" page; Try again starts a new core', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    for (let i = 0; i < 5; i += 1) {
      children[i]?.exit(1);
      (proc.timers as FakeTimers).advance(30_000);
    }
    expect(children).toHaveLength(5);
    expect(lastPage()).toBe(statusPageUrl('exited'));
    expect(FakeTray.created[0]?.tooltip).toBe('AgentLink: Not running');
    expect(click(STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(children).toHaveLength(6);
    expect(lastPage()).toBe(statusPageUrl('starting'));
  });

  it('a core that stops after ready → the starting page while it restarts', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stream.push(readyLine());
    expect(lastPage()).toBe(SESSION_URL);
    children[0]?.exit(1);
    (proc.timers as FakeTimers).advance(1_000);
    expect(children).toHaveLength(2);
    expect(lastPage()).toBe(statusPageUrl('starting'));
    children[1]?.stream.push(readyLine(`http://localhost:5555/?t=${'C'.repeat(43)}`));
    expect(lastPage()).toBe(`http://localhost:5555/?t=${'C'.repeat(43)}`);
  });

  it('keeps the core’s stderr, redacted, in core.log; Open log folder opens that folder', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stderr.push(
      `Error: something broke at http://localhost:4567/?t=${'Z'.repeat(43)}\n`,
    );
    children[0]?.exit(1);
    const text = readFileSync(join(proc.logDir, CORE_LOG_FILE), 'utf8');
    expect(text).toContain('Error: something broke at [link removed]');
    expect(text).not.toContain('ZZZZ');
    expect(text).toMatch(/core started/);
    expect(text).toMatch(/core exited \(code 1\)/);
    for (let i = 1; i < 5; i += 1) {
      (proc.timers as FakeTimers).advance(30_000);
      children[i]?.exit(1);
    }
    expect(click(STATUS_ACTION_URLS['open-log-folder'])).toBe(true);
    expect(electron.openedPaths).toEqual([proc.logDir]);
  });

  it('the session page cannot use the status actions', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stream.push(readyLine());
    expect(click(STATUS_ACTION_URLS['open-log-folder'])).toBe(true);
    expect(click(STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(electron.openedPaths).toEqual([]);
    expect(children).toHaveLength(1);
  });

  it('loads only the session link from the pipe', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stream.push(readyLine());
    const window = FakeBrowserWindow.created[0];
    expect(window?.loaded).toEqual([statusPageUrl('starting'), SESSION_URL]);
    // A link on another origin from the same core is refused.
    children[0]?.stream.push(readyLine(`http://localhost:1/?t=${'B'.repeat(43)}`));
    expect(window?.loaded).toEqual([statusPageUrl('starting'), SESSION_URL]);
  });

  it('locks every webContents that is ever created', async () => {
    const { electron, proc } = setup();
    await runShell(electron, proc);
    const contents = new FakeWebContents();
    electron.app.emit('web-contents-created', new FakeEvent(), contents);
    expect(contents.navigate('will-navigate', 'https://evil.example/')).toBe(true);
    expect(contents.windowOpenHandler?.({ url: 'https://evil.example/' })).toEqual({
      action: 'deny',
    });
  });

  it('a core that could not start → its fixed page in the window, no restart, Try again', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stream.push('{"v":1,"type":"stopped","reason":"keychain"}\n');
    children[0]?.exit(1);
    expect(lastPage()).toBe(statusPageUrl('keychain'));
    expect(electron.dialog.shown).toHaveLength(0);
    (proc.timers as FakeTimers).advance(120_000);
    expect(children).toHaveLength(1);
    expect(click(STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(children).toHaveLength(2);
    expect(lastPage()).toBe(statusPageUrl('starting'));
    children[1]?.stream.push('{"v":1,"type":"stopped","reason":"keychain"}\n');
    children[1]?.exit(1);
    const menu = FakeTray.created[0]?.menu as { template: { click?: () => void }[] };
    menu.template[1]?.click?.();
    expect(children).toHaveLength(3);
  });

  it('a protocol violation stops the core; nothing is loaded', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    children[0]?.stream.push('{"v":1,"type":"navigate","url":"https://evil.example/"}\n');
    expect(children[0]?.kills).toEqual(['SIGKILL']);
    expect(FakeBrowserWindow.created[0]?.loaded).toEqual([statusPageUrl('starting')]);
  });
});

describe('runShell deep links', () => {
  it('ignores deep links until the WP-D9 handler exists', async () => {
    const { electron, children, proc } = setup(['--', `agentlink://join#${SHORT}`]);
    await runShell(electron, proc);
    expect(children[0]?.stream.written).toEqual([]);
  });

  it('sends the handler’s canonical invite link over the pipe', async () => {
    const seen: string[] = [];
    const { electron, children, proc } = setup(['--', `agentlink://join#${SHORT}`], {
      toInviteLink: (link) => {
        seen.push(link);
        return INVITE;
      },
    });
    await runShell(electron, proc);
    expect(seen).toEqual([`agentlink://join#${SHORT}`]);
    expect(children[0]?.stream.written).toEqual([
      `${JSON.stringify({ v: 1, type: 'invite', link: INVITE })}\n`,
    ]);
  });

  it('drops an invalid link from the handler (never on the pipe)', async () => {
    const { electron, children, proc } = setup(['--', 'agentlink://join#x'], {
      toInviteLink: () => 'https://evil.example/i#x',
    });
    await runShell(electron, proc);
    expect(children[0]?.stream.written).toEqual([]);
  });

  it('second launch: only the forwarded deep link is read, then the window is shown', async () => {
    const seen: string[] = [];
    const { electron, children, proc } = setup([], {
      toInviteLink: (link) => {
        seen.push(link);
        return null;
      },
    });
    await runShell(electron, proc);
    electron.app.emit(
      'second-instance',
      new FakeEvent(),
      [EXE, '--remote-debugging-port=1', 'agentlink://raw-argv'],
      '/',
      { deepLink: 'agentlink://join#fwd' },
    );
    expect(seen).toEqual(['agentlink://join#fwd']);
    // No window yet: the shell asks the core for the home page.
    expect(children[0]?.stream.written).toEqual(['{"v":1,"type":"show","route":"home"}\n']);
  });

  it('open-url (macOS) accepts only agentlink://', async () => {
    const seen: string[] = [];
    const { electron, proc } = setup([], {
      toInviteLink: (link) => {
        seen.push(link);
        return null;
      },
    });
    await runShell(electron, proc);
    const a = new FakeEvent();
    electron.app.emit('open-url', a, 'https://evil.example/');
    electron.app.emit('open-url', new FakeEvent(), 'agentlink://join#ok');
    expect(a.defaultPrevented).toBe(true);
    expect(seen).toEqual(['agentlink://join#ok']);
  });
});

describe('runShell quit', () => {
  it('quit sends shutdown and exits after the core has gone', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    const event = new FakeEvent();
    electron.app.emit('before-quit', event);
    expect(event.defaultPrevented).toBe(true);
    expect(children[0]?.stream.written).toEqual(['{"v":1,"type":"shutdown"}\n']);
    expect(electron.app.quitCalls).toBe(0);
    children[0]?.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(electron.app.quitCalls).toBe(1);
    expect(FakeTray.created[0]?.destroyed).toBe(true);
  });
});

describe('preview mode', () => {
  it('is off without the build-time constant (tests and release builds)', () => {
    expect(readPreview({ AGENTLINK_DESKTOP_PREVIEW: '1' })).toBeNull();
  });
});
