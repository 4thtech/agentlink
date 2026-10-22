// M1-11s-b: the first-run page's API (08 §1). A stub until the page's card fills this file; that card
// adds its routes here (a mutating one must declare `presence: true`, route-types.ts).
// M1-11s-c: owner setup (D-120 (1)): begin and finish are setup routes, run by the approval server's
// setup gate (approval-server.ts, owner-setup.ts), not by a handler here.
import { pageStub, type LocalUiRoute } from '../route-types.js';

export const firstRunRoutes: readonly LocalUiRoute[] = Object.freeze([
  pageStub('first-run'),
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
