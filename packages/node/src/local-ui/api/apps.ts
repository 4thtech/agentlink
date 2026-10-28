// U3-c: reserved routes of card U3-f (08 §1 AI apps; 04 §2.5 "Writing AI app configs"). Each answers
// 501 `not_available` until U3-f replaces the stub with its handler: the reads before anything else,
// apply and disconnect before any presence check.
import type { LocalUiRoute } from '../route-types.js';
import { ownerStub, readStub } from '../route-types.js';

export const appsRoutes: readonly LocalUiRoute[] = Object.freeze([
  readStub('/api/ui/apps'),
  readStub('/api/ui/apps/preview'),
  ownerStub('/api/ui/apps/apply'),
  ownerStub('/api/ui/apps/disconnect'),
]);
