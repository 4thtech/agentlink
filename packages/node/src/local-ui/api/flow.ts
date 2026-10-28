// U3-c: the reserved route of card U3-flow (08 §1 live connections). It answers 501 `not_available`
// until U3-flow replaces the stub with its handler.
import type { LocalUiRoute } from '../route-types.js';
import { readStub } from '../route-types.js';

export const flowRoutes: readonly LocalUiRoute[] = Object.freeze([readStub('/api/ui/flow')]);
