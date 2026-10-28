// U3-b (USABILITY-WAVE-3 §7.4; 06 §8): which agent a command without `--agent` means. The CLI never
// asks. In this order: the last used agent (`~/.agentlink/app.json`), else an agent an AI app already
// serves (`default` first), else the first by name. Only names that pass the 06 §6 pattern are ever
// chosen (a recorded name is agent-written text); nothing else about an agent is read or shown.
import { DEFAULT_AGENT_NAME, isAgentName } from '../runtime/agent-name.js';
import {
  detectHarnesses,
  planHarness,
  type HarnessContext,
  type HarnessDef,
} from '../harness/index.js';

/** The valid, distinct agent names, sorted. */
function validNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => isAgentName(n)))].sort();
}

/**
 * The agent to use. `last` is app.json's name (ignored unless it is an agent here); `serves` tells
 * whether an AI app is set up to start that agent (a failing check counts as "no"). `undefined`
 * only when there is no agent at all.
 */
export async function chooseCurrentAgent(
  names: readonly string[],
  last: string | undefined,
  serves: (name: string) => Promise<boolean>,
): Promise<string | undefined> {
  const valid = validNames(names);
  const [first] = valid;
  if (first === undefined) return undefined;
  if (valid.length === 1) return first;
  if (last !== undefined && valid.includes(last)) return last;
  // `default` is tried first, then the rest by name.
  const ordered = valid.includes(DEFAULT_AGENT_NAME)
    ? [DEFAULT_AGENT_NAME, ...valid.filter((n) => n !== DEFAULT_AGENT_NAME)]
    : valid;
  for (const name of ordered) {
    if (await serves(name).catch(() => false)) return name;
  }
  return first;
}

/**
 * Whether an AI app already starts `name`: an app's settings hold the `agentlink` entry exactly as
 * `init` would write it for that agent (`present`). Read-only: nothing is written or shown.
 * `apps`: the apps to look in; absent, the apps found on this computer.
 */
export function appServes(
  context: HarnessContext,
  apps?: readonly HarnessDef[],
): (name: string) => Promise<boolean> {
  let found: readonly HarnessDef[] | undefined = apps;
  const base: HarnessContext = { ...context };
  delete (base as { agent?: string }).agent;
  return async (name) => {
    found ??= await detectHarnesses(base);
    const candidate: HarnessContext = name === DEFAULT_AGENT_NAME ? base : { ...base, agent: name };
    for (const def of found) {
      const plan = await planHarness(def, candidate);
      if (plan.status === 'present') return true;
    }
    return false;
  };
}
