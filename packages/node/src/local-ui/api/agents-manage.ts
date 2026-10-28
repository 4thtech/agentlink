// U3-c: reserved routes of card U3-d (08 §1): create an agent and change its label. Each answers 501
// `not_available` before any presence check until U3-d replaces the stub with its handler (presence;
// signs the agent's card and first policy, or `agent.label`).
import type { LocalUiRoute } from '../route-types.js';
import { ownerStub } from '../route-types.js';

export const agentsManageRoutes: readonly LocalUiRoute[] = Object.freeze([
  ownerStub('/api/ui/agents'),
  ownerStub('/api/ui/agents/label'),
]);
