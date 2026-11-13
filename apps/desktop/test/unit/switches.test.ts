// Launch lockdown (src/main/switches.ts; plan Decision 3, Fable H1): an allowlist of arguments;
// every forbidden switch, Node option and environment variable is a refusal.
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SWITCHES,
  checkLaunch,
  commandLineIsClean,
  forwardedDeepLink,
  type LaunchInput,
} from '../../src/main/switches.js';

const EXE = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';
const LINK = 'agentlink://join#2.abc';

const input = (args: string[], over: Partial<LaunchInput> = {}): LaunchInput => ({
  argv: [EXE, ...args],
  execArgv: [],
  env: { HOME: '/Users/x', PATH: '/usr/bin' },
  platform: 'darwin',
  packaged: true,
  preview: false,
  ...over,
});

/** Each switch the plan names, in the forms Chromium accepts. */
const FORBIDDEN_ARGS = [
  '--remote-debugging-port=9222',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--inspect',
  '--inspect=9229',
  '--inspect-brk',
  '--inspect-port=1',
  '--js-flags=--allow-natives-syntax',
  '--proxy-server=http://evil.example:8080',
  '--disable-web-security',
  '--host-rules=MAP * evil.example',
  '--host-resolver-rules=MAP localhost evil.example',
  '--user-data-dir=/tmp/x',
  '--load-extension=/tmp/ext',
  '--enable-logging',
  '--enable-logging=stderr',
  '--no-sandbox',
  '--some-unknown-switch',
  '-remote-debugging-port=9222',
  '/remote-debugging-port=9222',
  '--',
];

describe('checkLaunch', () => {
  it('accepts a plain launch', () => {
    expect(checkLaunch(input([]))).toEqual({ ok: true, deepLink: null, userDataDir: null });
  });

  it('accepts one agentlink:// link after the separator', () => {
    expect(checkLaunch(input(['--', LINK]))).toEqual({
      ok: true,
      deepLink: LINK,
      userDataDir: null,
    });
  });

  it('accepts the macOS process serial number once', () => {
    expect(checkLaunch(input(['-psn_0_12345'])).ok).toBe(true);
    expect(checkLaunch(input(['-psn_0_1', '-psn_0_2'])).ok).toBe(false);
    expect(checkLaunch(input(['-psn_0_12345'], { platform: 'win32' })).ok).toBe(false);
  });

  it('skips the app path in a development run only', () => {
    expect(checkLaunch(input(['/repo/apps/desktop'], { packaged: false })).ok).toBe(true);
    expect(checkLaunch(input(['/repo/apps/desktop'])).ok).toBe(false);
  });

  it.each(FORBIDDEN_ARGS.filter((a) => a !== '--'))('refuses %s', (arg) => {
    expect(checkLaunch(input([arg])).ok).toBe(false);
    expect(checkLaunch(input([arg, '--', LINK])).ok).toBe(false);
    expect(checkLaunch(input(['-psn_0_1', arg])).ok).toBe(false);
  });

  it('refuses a positional argument', () => {
    expect(checkLaunch(input(['agentlink://join#x']))).toEqual({ ok: false, reason: 'positional' });
    expect(checkLaunch(input(['hello'])).ok).toBe(false);
  });

  it('refuses a crafted link that tries to add switches', () => {
    expect(checkLaunch(input(['--', LINK, '--remote-debugging-port=1']))).toEqual({
      ok: false,
      reason: 'after_deep_link',
    });
    expect(checkLaunch(input(['--', '--remote-debugging-port=1']))).toEqual({
      ok: false,
      reason: 'deep_link',
    });
    expect(checkLaunch(input(['--', 'https://evil.example/']))).toEqual({
      ok: false,
      reason: 'deep_link',
    });
    // A link with a switch-looking tail stays one argument: accepted here, checked by WP-D9.
    expect(checkLaunch(input(['--', 'agentlink://x --remote-debugging-port=1'])).ok).toBe(true);
  });

  it('refuses an over-long link', () => {
    expect(checkLaunch(input(['--', `agentlink://${'a'.repeat(40_000)}`])).ok).toBe(false);
  });

  it('refuses Node options on the main process', () => {
    expect(checkLaunch(input([], { execArgv: ['--inspect'] }))).toEqual({
      ok: false,
      reason: 'exec_argv',
    });
  });

  it.each([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_LOG_FILE',
    'electron_run_as_node',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NODE_PATH',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'node_anything',
    'SSLKEYLOGFILE',
  ])('refuses the environment variable %s', (name) => {
    expect(checkLaunch(input([], { env: { HOME: '/x', [name]: '1' } }))).toEqual({
      ok: false,
      reason: 'env',
    });
  });

  it('allows --user-data-dir only in a preview build, absolute, before the separator', () => {
    expect(checkLaunch(input(['--user-data-dir=/tmp/home/ud'], { preview: true }))).toEqual({
      ok: true,
      deepLink: null,
      userDataDir: '/tmp/home/ud',
    });
    expect(checkLaunch(input(['--user-data-dir=/tmp/home/ud'], { preview: false })).ok).toBe(false);
    expect(checkLaunch(input(['--user-data-dir=relative'], { preview: true })).ok).toBe(false);
    expect(checkLaunch(input(['--user-data-dir='], { preview: true })).ok).toBe(false);
    expect(
      checkLaunch(input(['--user-data-dir=/a', '--user-data-dir=/b'], { preview: true })).ok,
    ).toBe(false);
    // Other switches stay forbidden in preview.
    expect(checkLaunch(input(['--remote-debugging-port=1'], { preview: true })).ok).toBe(false);
  });

  it('never puts the offending value in the refusal', () => {
    const result = checkLaunch(input(['--proxy-server=http://secret-token@evil.example']));
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});

describe('commandLineIsClean', () => {
  it.each(FORBIDDEN_SWITCHES)('refuses %s on Chromium’s command line', (name) => {
    expect(commandLineIsClean((s) => s === name, false)).toBe(false);
  });

  it('accepts a clean command line and the preview user-data-dir', () => {
    expect(commandLineIsClean(() => false, false)).toBe(true);
    expect(commandLineIsClean((s) => s === 'user-data-dir', true)).toBe(true);
    expect(commandLineIsClean((s) => s === 'user-data-dir', false)).toBe(false);
  });

  it('accepts the switch Electron adds itself (allow-file-access-from-files), refused in argv', () => {
    expect(commandLineIsClean((s) => s === 'allow-file-access-from-files', false)).toBe(true);
    expect(checkLaunch(input(['--allow-file-access-from-files'])).ok).toBe(false);
  });
});

describe('forwardedDeepLink', () => {
  it('reads only { deepLink } with an agentlink:// string', () => {
    expect(forwardedDeepLink({ deepLink: LINK })).toBe(LINK);
    expect(forwardedDeepLink({ deepLink: null })).toBeNull();
    expect(forwardedDeepLink({ deepLink: 'https://evil.example' })).toBeNull();
    expect(forwardedDeepLink({ deepLink: LINK, argv: ['--inspect'] })).toBeNull();
    expect(forwardedDeepLink([LINK])).toBeNull();
    expect(forwardedDeepLink(LINK)).toBeNull();
    expect(forwardedDeepLink(null)).toBeNull();
    expect(forwardedDeepLink(Object.create({ deepLink: LINK }))).toBeNull();
  });
});
