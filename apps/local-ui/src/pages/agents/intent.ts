// W4-AGENTS (08 §1 "Pause an agent": "Pause on another agent switches to it first, as every agent
// action does"): Pause, Resume and the AI apps act on the open agent only. On another agent the page
// switches first; the switch mounts every view again (router.tsx), so what the person asked for is
// kept for this tab in sessionStorage and picked up by the page once its own read shows that agent
// open. A read that still shows the old agent (the shared store answered before the switch) leaves
// it in place; it expires after INTENT_TTL_MS. It holds only a folder name, a fixed action word and
// a time; it is never sent anywhere.
export const INTENT_KEY = 'agentlink.agents.intent';
/** A switch answers within seconds; an intent older than this is dropped. */
export const INTENT_TTL_MS = 60_000;

export type IntentAction = 'pause' | 'resume' | 'apps';
export interface Intent {
  readonly name: string;
  readonly action: IntentAction;
}

const ACTIONS: ReadonlySet<string> = new Set(['pause', 'resume', 'apps']);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function rememberIntent(intent: Intent, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, at: now }));
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

/**
 * The intent for `open` (the agent open now, from the page's own fresh read), taken once. An intent
 * for another agent stays until it expires (the read may predate the switch); a malformed or
 * expired one is dropped.
 */
export function takeIntent(
  open: string | null,
  now: number = Date.now(),
): IntentAction | undefined {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(INTENT_KEY);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  let v: { name?: unknown; action?: unknown; at?: unknown };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    forgetIntent();
    return undefined;
  }
  // W4-WIRE (U5 low): an entry with no time (an older format) is dropped, never taken as now (it
  // would then never expire).
  const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : undefined;
  if (
    at === undefined ||
    typeof v.name !== 'string' ||
    !NAME.test(v.name) ||
    typeof v.action !== 'string' ||
    !ACTIONS.has(v.action) ||
    now - at > INTENT_TTL_MS ||
    at - now > INTENT_TTL_MS
  ) {
    forgetIntent();
    return undefined;
  }
  if (v.name !== open) return undefined;
  forgetIntent();
  return v.action as IntentAction;
}
