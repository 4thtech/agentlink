// Installing AgentLink on this computer (M1-36b; owner decision D1 of 2026-10-22). `init` offers it
// in a terminal the owner opened, shows this exact command first, and runs it only after a `y`.
// Nothing here is chosen by an agent or by inbound content: the program, its arguments and the
// package name are fixed. npx stays the fallback when the owner says no or the install fails.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_NAME } from '../harness/index.js';

/** `npm` and its fixed arguments. */
export const INSTALL_ARGS: readonly string[] = Object.freeze(['i', '-g', PACKAGE_NAME]);
/** The command as the owner reads it before saying yes. */
export const INSTALL_COMMAND = `npm ${INSTALL_ARGS.join(' ')}`;

/** True when a file named `agentlink` (`.cmd`/`.exe` on Windows) is on PATH. */
export function isAgentlinkOnPath(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const names = platform === 'win32' ? ['agentlink.cmd', 'agentlink.exe'] : ['agentlink'];
  const path = env['PATH'] ?? env['Path'] ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of path.split(sep)) {
    if (dir === '') continue;
    for (const name of names) {
      try {
        if (statSync(join(dir, name)).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * Runs `npm i -g @4thtech-io/agentlink`. True only when npm exits with 0. npm's own output is not
 * printed (no console channel here, and it is not ours to sanitize); a failure is reported in `init`'s
 * own words with the command to retry. `execFile`, never a shell string built from input (the bundle allows only
 * that import, bundle-check): on Windows `npm` is a `.cmd`, run through `cmd.exe` with the same fixed
 * text, since Node refuses to start a `.cmd` directly.
 */
export function installGlobally(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    const [file, args] =
      platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', INSTALL_COMMAND]]
        : ['npm', [...INSTALL_ARGS]];
    execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000, windowsHide: true },
      (error) => resolve(error === null),
    );
  });
}
