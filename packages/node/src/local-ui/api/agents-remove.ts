// U3-c: the reserved route of card U3-e (08 §1; 04 §2.5 "Removing an agent"). It answers 501
// `not_available` before any presence check until U3-e replaces the stub with its handler (presence;
// signs `agent.revoke`).
import type { LocalUiRoute } from '../route-types.js';
import { ownerStub } from '../route-types.js';

export const agentsRemoveRoutes: readonly LocalUiRoute[] = Object.freeze([
  ownerStub('/api/ui/agents/remove'),
]);
