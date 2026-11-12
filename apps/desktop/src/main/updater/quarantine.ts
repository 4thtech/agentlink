// WP-D10 (Decision 5, phase 1): the downloaded installer carries the operating system's "downloaded
// from the internet" mark, so Gatekeeper (macOS) and SmartScreen (Windows) check it when the person
// opens it, exactly as for a browser download. Without the mark the OS would skip those checks.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

/** macOS `com.apple.quarantine`: flags 0081 (downloaded, not yet opened), time, agent name. */
export function macQuarantineValue(nowMs: number): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};AgentLink;`;
}

/** Windows Mark of the Web: Zone 3 (Internet) in the file's Zone.Identifier stream. */
export const WINDOWS_ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

export function markDownloaded(path: string, platform: string, nowMs: number): Promise<void> {
  if (platform === 'win32') {
    return writeFile(`${path}:Zone.Identifier`, WINDOWS_ZONE_IDENTIFIER, { flag: 'w' });
  }
  if (platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile(
        '/usr/bin/xattr',
        ['-w', 'com.apple.quarantine', macQuarantineValue(nowMs), path],
        { timeout: 10_000 },
        (error) => (error ? reject(new Error('could not mark the installer')) : resolve()),
      );
    });
  }
  return Promise.reject(new Error('unsupported platform'));
}
