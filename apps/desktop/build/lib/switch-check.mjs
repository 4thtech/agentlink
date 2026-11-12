// Launch-test list for the switch lockdown (Decision 3 / H1): the built binary must exit non-zero
// with no window for each of these.
export const FORBIDDEN_SWITCHES = [
  '--remote-debugging-port=9222',
  '--remote-debugging-pipe',
  '--inspect',
  '--inspect=9229',
  '--inspect-brk',
  '--inspect-port=9229',
  '--js-flags=--expose-gc',
  '--proxy-server=127.0.0.1:1',
  '--disable-web-security',
  '--host-rules=MAP * 127.0.0.1',
  '--user-data-dir=/tmp/agentlink-lockdown-test',
  '--load-extension=/tmp/agentlink-lockdown-test',
  '--enable-logging',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-certificate-errors',
  '--some-unknown-switch',
  // single-dash and Windows-style forms of the same switches
  '-inspect',
  '-remote-debugging-port=9222',
  '-user-data-dir=/tmp/agentlink-lockdown-test',
  '/inspect',
  '/remote-debugging-port=9222',
  '/some-unknown-switch',
];

// Argument lists that mix a (valid-looking) invite link with a switch: a switch after the link, with
// or without the `--` separator, and a second argument after the separator.
export const EXTRA_CASES = [
  ['--', 'agentlink://invite#x', '--remote-debugging-port=9222'],
  ['--', 'agentlink://invite#x', '--inspect'],
  ['agentlink://invite#x', '--inspect'],
  ['--inspect', '--', 'agentlink://invite#x'],
  ['--', '--inspect'],
  ['--', 'agentlink://invite#x', 'agentlink://second#y'],
];

// D15-05: environment variables the built app must refuse (exit 64 before the lock, a window or the
// core). Each case is launched with no arguments. NOT listed: NODE_OPTIONS and NODE_EXTRA_CA_CERTS.
// With the NodeOptions fuse off Electron removes them before any JS runs, so the app would START
// (with the option ignored); the fuse check (check-fuses.mjs) covers them, and a launch here would
// start the real core.
export const ENV_CASES = [
  { ELECTRON_RUN_AS_NODE: '1' },
  { ELECTRON_ENABLE_LOGGING: '1' },
  { ELECTRON_ENABLE_STACK_DUMPING: '1' },
  { node_options: '--inspect=9339' },
  { NODE_DEBUG: 'net' },
  { SSLKEYLOGFILE: '/tmp/agentlink-lockdown-test/keys' },
];

/**
 * launch(exe, args, env?) -> Promise<{code: number|null, windowSeen: boolean}> (code null = timed
 * out); `env` holds the extra variables of an environment case, undefined for argument cases.
 * Returns {checked, failures}; failures lists every switch that did not exit non-zero with no window.
 */
export async function runLockdown({
  exe,
  launch,
  switches = FORBIDDEN_SWITCHES,
  extra = EXTRA_CASES,
  envCases = ENV_CASES,
}) {
  const failures = [];
  const cases = [
    ...switches.map((sw) => ({ argv: [sw] })),
    ...extra.map((argv) => ({ argv })),
    ...envCases.map((env) => ({ argv: [], env })),
  ];
  for (const { argv, env } of cases) {
    const sw = env ? `env ${Object.keys(env).join(' ')}` : argv.join(' ');
    let r;
    try {
      r = await launch(exe, argv, env);
    } catch (e) {
      failures.push(`${sw}: launch error (${e.message})`);
      continue;
    }
    if (r.code === null) failures.push(`${sw}: did not exit (timed out)`);
    else if (r.code === 0) failures.push(`${sw}: exited 0`);
    else if (r.windowSeen) failures.push(`${sw}: a window appeared`);
  }
  return { checked: cases.length, failures };
}
