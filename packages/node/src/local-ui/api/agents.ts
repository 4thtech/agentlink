// U3-c: the Agents list and switching in the app host (08 §1 "Agents and AI apps in the app"; 04 §2.5
// "Several agents in one app"; 06 §6; D-138; I-4, I-7).
//
// - `GET /api/ui/agents` (read): every agent folder of this owner with its name, label (plain text,
//   display only), whether it is the open one, the generation, its contact count, Running and
//   `removing`. W4-LIVE-STATUS (D-143): Running is a live MCP session row (06 §6), never the lease;
//   each agent also carries `state`, `lastSeenAt?` and `apps: [{app, state, since?, lastSeenAt?}]`.
//   No path, agent ID, key or file content. Outside the app host (an approval page opened by an MCP
//   process) it answers `{switchable: false}`: that page stays bound to its agent ("Open the
//   AgentLink app to switch").
// - `POST /api/ui/agents/switch` `{name, generation}`: the switch kind (route-types.ts), run by the
//   server's switch gate; no handler here, no presence, nothing signed, only `app.json` written.
import type { LocalUiReadRoute, LocalUiRoute, LocalUiSwitchRoute } from '../route-types.js';
import { AGENTS_SWITCH_PATH, UI_INVALID_QUERY, UI_UNAVAILABLE } from '../route-types.js';
import { liveAgentRecord } from '../live-status.js';

export const AGENTS_PATH = '/api/ui/agents';

const listRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: AGENTS_PATH,
  presence: false,
  handler: async (context, request) => {
    // No query parameter is defined: anything sent is refused, never echoed.
    if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
    const desk = context.agents;
    if (desk === undefined) {
      return { status: 200, body: { switchable: false, agents: [] } };
    }
    try {
      const list = await desk.list();
      return {
        status: 200,
        body: {
          switchable: true,
          generation: list.generation,
          current: list.current,
          label: list.label,
          // W4-LIVE-STATUS: the allowlisted fields come from the one allowlist the event stream
          // uses (live-status.ts liveAgentRecord); the rest are this read's own counts and flags.
          agents: list.agents.map((agent) => {
            const live = liveAgentRecord(agent);
            return {
              name: live.name,
              label: live.label,
              labelled: agent.labelled === true,
              current: live.current,
              available: agent.available,
              removing: live.removing,
              contacts: agent.contacts,
              running: agent.running,
              state: live.state,
              ...(live.lastSeenAt === undefined ? {} : { lastSeenAt: live.lastSeenAt }),
              apps: live.apps.map((app) => ({ ...app })),
            };
          }),
        },
      };
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

/** The switch kind's one route (approval-server.ts switchGate runs it). */
export const agentsSwitchRoute: LocalUiSwitchRoute = Object.freeze<LocalUiSwitchRoute>({
  method: 'POST',
  path: AGENTS_SWITCH_PATH,
  presence: 'switch',
});

export const agentsRoutes: readonly LocalUiRoute[] = Object.freeze([listRoute, agentsSwitchRoute]);
