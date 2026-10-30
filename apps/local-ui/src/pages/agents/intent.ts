// W4-AGENTS (08 §1 "Pause an agent": "Pause on another agent switches to it first, as every agent
// action does"): Pause, Resume and the AI apps act on the open agent only. On another agent the page
// switches first; the switch mounts every view again (router.tsx), so what the person asked for is
// kept for this tab in sessionStorage and picked up once by the page for the agent now open. It holds
// only a folder name and a fixed action word; it is never sent anywhere.
export const INTENT_KEY = 'agentlink.agents.intent';

export type IntentAction = 'pause' | 'resume' | 'apps';
export interface Intent {
  readonly name: string;
  readonly action: IntentAction;
}

const ACTIONS: ReadonlySet<string> = new Set(['pause', 'resume', 'apps']);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function rememberIntent(intent: Intent): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Storage off: the switch still happens; the person clicks again.
  }
}

export function forgetIntent(): void {
  try {
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The intent for `open` (the agent open now), taken once; any other intent is dropped. */
export function takeIntent(open: string | null): IntentAction | undefined {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(INTENT_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  forgetIntent();
  try {
    const v = JSON.parse(raw) as { name?: unknown; action?: unknown };
    if (
      typeof v.name === 'string' &&
      NAME.test(v.name) &&
      v.name === open &&
      typeof v.action === 'string' &&
      ACTIONS.has(v.action)
    ) {
      return v.action as IntentAction;
    }
  } catch {
    // Not ours.
  }
  return undefined;
}
