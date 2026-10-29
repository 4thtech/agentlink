// The first-run page's API (08 §1; M1-11b-1).
// - `GET /api/ui/first-run`: whether approvals are protected yet, as one fixed word: `missing` (no
//   owner: the page offers setup), `set_up` (the agent card names an owner) or `unknown` (the check
//   failed; the page sends the owner to `agentlink doctor`). Nothing else: no key, fingerprint or
//   error text. A read route (no presence); the setup gate decides again on every setup request.
// - M1-11s-c: owner setup (D-120 (1)): begin and finish are setup routes, run by the approval server's
//   setup gate (approval-server.ts, owner-setup.ts), not by a handler here.
import type { LocalUiContext } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult, LocalUiRoute } from '../route-types.js';

export type FirstRunOwnerState = 'missing' | 'set_up' | 'unknown';

/** GET /api/ui/first-run. */
export async function firstRunStatus(context: LocalUiContext): Promise<LocalUiResult> {
  let owner: FirstRunOwnerState;
  try {
    // U3-g-b: with no agent yet, the real state (an owner or an agent folder elsewhere is set_up).
    const blocked = context.setupBlocked;
    if (blocked !== undefined) owner = (await blocked()) ? 'set_up' : 'missing';
    else owner = (await context.ownerContext()) === undefined ? 'missing' : 'set_up';
  } catch {
    owner = 'unknown';
  }
  return { status: 200, body: { owner } };
}

const statusRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/first-run',
  presence: false,
  handler: (context: LocalUiContext) => firstRunStatus(context),
});

export const firstRunRoutes: readonly LocalUiRoute[] = Object.freeze([
  statusRoute,
  Object.freeze({
    method: 'POST',
    path: '/api/ui/first-run/owner/begin',
    presence: 'setup',
    step: 'begin',
  } as const),
  Object.freeze({
    method: 'POST',
    path: '/api/ui/first-run/owner/finish',
    presence: 'setup',
    step: 'finish',
  } as const),
]);
