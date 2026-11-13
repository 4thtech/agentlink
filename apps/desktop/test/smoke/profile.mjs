// The smoke test's throw-away profiles (never a real profile). Every profile is complete on its own:
// its own home and a small, explicit environment and, on macOS, its own unlocked login keychain.
//
// CI-823: macOS keeps the default keychain in the preferences under HOME, so a keychain made for one
// throw-away home is not the default keychain of another. The fd 3 controls moved to their own home
// (WIN-DESK-1 lows) without one: the host's first start needs the keychain, stopped with `keychain`
// and exited 1, which read as "the host did not send `ready` on the shell's pipe".
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The `security` calls that give `keychain` its own unlocked login keychain (golden-path setup). */
export const keychainSetup = (keychain) => [
  ['create-keychain', '-p', 'ci', keychain],
  ['default-keychain', '-s', keychain],
  ['unlock-keychain', '-p', 'ci', keychain],
  ['set-keychain-settings', keychain],
];

/**
 * A fresh throw-away profile: { home, env }. `deps` are for tests: platform, the temp root, the
 * `security` runner (spawnSync's result shape) and the warning sink.
 */
export function makeHome(opts = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? ((args, env) => spawnSync('security', args, { env, stdio: 'ignore' }));
  const warn = deps.warn ?? ((line) => console.error(line));
  const dir = mkdtempSync(join(deps.tmp ?? tmpdir(), 'agentlink-desktop-smoke-'));
  // No AI-app marker, nothing from the runner's secrets.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: join(dir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(dir, 'AppData', 'Local'),
    TMPDIR: dir,
    TEMP: dir,
    TMP: dir,
  };
  if (!opts.noRoaming) mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  // A fresh runner has no usable keychain under a temporary HOME (the same setup as
  // tools/ci/golden-path-published.mjs): on macOS each throw-away profile gets its own unlocked
  // login keychain, the way a person's login keychain is. The app's own keychain use is unchanged.
  // Windows has the Credential Manager.
  if (platform === 'darwin') {
    const keychains = join(dir, 'Library', 'Keychains');
    mkdirSync(keychains, { recursive: true });
    for (const args of keychainSetup(join(keychains, 'login.keychain-db'))) {
      const r = run(args, env);
      if (r.status !== 0) {
        // Only creating the keychain is fatal; the later calls can fail on a runner whose keychain
        // is already unlocked system-wide.
        if (args[0] === 'create-keychain') throw new Error('could not create the smoke keychain');
        warn(`::warning::smoke setup: security ${args[0]} exited ${r.status}`);
      }
    }
  }
  return { home: dir, env };
}
