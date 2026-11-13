// R1: the running CLI's version, set once by each entry (main.ts, desktop/host.ts), for the last-exit
// record, the app's status strip and update checks.
import { readFileSync } from 'node:fs';

let current = '0.0.0';

export function setCliVersion(version: string): void {
  current = version;
}

export function cliVersion(): string {
  return current;
}

const PACKAGE_NAME = '@4thtech-io/agentlink';

/**
 * HOTFIX-NOID (owner report: the Mac app's status strip said 0.0.0): the version in this package's
 * own package.json, from the first of `candidates` that is it (by name). The bundles sit in dist/
 * (dist/agentlink.js, dist/desktop-host.js: `../package.json`); the per-file build puts the desktop
 * entry one level deeper (dist/desktop/host.js). '0.0.0' when none can be read.
 */
export function readPackageVersion(candidates: readonly URL[]): string {
  for (const url of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
      const { name, version } = parsed as { name?: unknown; version?: unknown };
      if (name === PACKAGE_NAME && typeof version === 'string' && version !== '') return version;
    } catch {
      // The next candidate.
    }
  }
  return '0.0.0';
}
