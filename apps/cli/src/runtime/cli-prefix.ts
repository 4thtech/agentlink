// The command a user can paste to run AgentLink (M1-36a). After the documented install
// (`npx -y @4thtech-io/agentlink init`) the bare `agentlink` is not on the user's PATH, so every
// "run this" line must start with the form that works for how this program was started.
import { realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import process from 'node:process';

/** The documented zero-install form. */
export const NPX_PREFIX = 'npx -y @4thtech-io/agentlink';
/** The form after a global install. */
export const GLOBAL_PREFIX = 'agentlink';

export interface LaunchInfo {
  /** `process.argv[1]`: the script that started this program. */
  readonly script?: string;
  /** Whether an `agentlink` on the user's PATH is this very program. Default: looks at PATH. */
  readonly onPath?: (script: string) => boolean;
}

/** True when a file named `agentlink` on PATH resolves to the same file as `script`. */
function defaultOnPath(script: string): boolean {
  let real: string;
  try {
    real = realpathSync(script);
  } catch {
    return false;
  }
  const names = process.platform === 'win32' ? ['agentlink.cmd', 'agentlink.exe'] : ['agentlink'];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      try {
        if (realpathSync(join(dir, name)) === real) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * `agentlink` only when a global install is positively found: the bare name on PATH is this very
 * program. Everything else (npx, `npm exec`, `pnpm dlx`, `yarn dlx`, a local `.bin`, an absolute
 * path) gets the `npx` form, which works after the documented install.
 */
export function cliPrefix(info?: LaunchInfo): string {
  const script = info === undefined ? process.argv[1] : info.script;
  if (script === undefined || script === '') return NPX_PREFIX;
  const onPath = info?.onPath ?? defaultOnPath;
  return onPath(script) ? GLOBAL_PREFIX : NPX_PREFIX;
}
