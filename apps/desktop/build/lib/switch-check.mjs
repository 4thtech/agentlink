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

/**
 * launch(exe, args) -> Promise<{code: number|null, windowSeen: boolean}> (code null = timed out).
 * Returns {checked, failures}; failures lists every switch that did not exit non-zero with no window.
 */
export async function runLockdown({
  exe,
  launch,
  switches = FORBIDDEN_SWITCHES,
  extra = EXTRA_CASES,
}) {
  const failures = [];
  const cases = [...switches.map((sw) => [sw]), ...extra];
  for (const argv of cases) {
    const sw = argv.join(' ');
    let r;
    try {
      r = await launch(exe, argv);
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
