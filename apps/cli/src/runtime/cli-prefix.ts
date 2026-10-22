// The command a user can paste to run AgentLink (M1-36a). After the documented install
// (`npx -y @4thtech-io/agentlink init`) the bare `agentlink` is not on the user's PATH, so every
// "run this" line must start with the form that works for how this program was started.
import process from 'node:process';

/** The documented zero-install form. */
export const NPX_PREFIX = 'npx -y @4thtech-io/agentlink';
/** The form after a global install. */
export const GLOBAL_PREFIX = 'agentlink';

export interface LaunchInfo {
  /** `process.argv[1]`: the script that started this program. */
  readonly script?: string;
  /** `process.env`; only `npm_command` is read. */
  readonly env?: { readonly npm_command?: string | undefined };
}

/**
 * `agentlink` when this program runs from an installed copy, otherwise the `npx` form. npx and
 * `npm exec` start the program from a temporary `_npx` cache (and set `npm_command=exec`), so
 * either sign means the bare name is not on PATH.
 */
export function cliPrefix(info?: LaunchInfo): string {
  const script = info === undefined ? process.argv[1] : info.script;
  const env = info?.env ?? process.env;
  const viaNpx =
    env.npm_command === 'exec' || (script !== undefined && /[\\/]_npx[\\/]/.test(script));
  return viaNpx ? NPX_PREFIX : GLOBAL_PREFIX;
}
