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
];

/**
 * launch(exe, args) -> Promise<{code: number|null, windowSeen: boolean}> (code null = timed out).
 * Returns {checked, failures}; failures lists every switch that did not exit non-zero with no window.
 */
export async function runLockdown({ exe, launch, switches = FORBIDDEN_SWITCHES }) {
  const failures = [];
  for (const sw of switches) {
    let r;
    try {
      r = await launch(exe, [sw]);
    } catch (e) {
      failures.push(`${sw}: launch error (${e.message})`);
      continue;
    }
    if (r.code === null) failures.push(`${sw}: did not exit (timed out)`);
    else if (r.code === 0) failures.push(`${sw}: exited 0`);
    else if (r.windowSeen) failures.push(`${sw}: a window appeared`);
  }
  return { checked: switches.length, failures };
}
