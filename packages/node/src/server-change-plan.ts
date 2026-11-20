// NET-OWNER-SET, NET-CLI (S2; D-158 (2), (3), (5), (7); 07 §4.3 "Use your own servers"; 04 §2.5.1,
// §2.6, §4; I-4, I-7): the one planner of a server-list change, shared by the app's routes
// (local-ui/api/network-servers.ts) and the owner's terminal (owner-server-change-terminal.ts), so
// both test, build and refuse exactly alike.
//
// - The agent's state first: paused (`agent_paused`), an unfinished change (`rotation_pending`),
//   anything else not ready (`not_applied`); the same list (`same_list`).
// - The opt-out only while the list holds no default (or old default) server: `mix_in_on`.
// - Every own server tested again here (transport precheckServers through `test`; the caller's
//   budget, `busy` over it), the default set too with the mix-in; then core buildServerList.
// - The leaving servers (M1-7j): more than 16 is `too_many_previous`, with the time it fits from.
// - The review: hosts (never a full address), roles, outcomes, the leaving servers' ends, the
//   contact count and the fixed warning codes. Nothing here signs, writes or logs.
//
// Internal to the package: no export from index.ts.
import {
  AUTOMATIC_SERVERS,
  automaticServerPlan,
  buildServerList,
  holdsDefaultServer,
  isAutomaticList,
  planLeaving,
  type LeavingServer,
  type SendState,
  type ServerListPlan,
  type ServerListWarning,
  type TestedServer,
} from '@4thtech-io/core';
import { relayOrigin, type PrecheckResult } from '@4thtech-io/transport-nostr';

/** One change: the owner's own list with the mix-in and announce choices, or the reset. */
export interface ServerChangeAsk {
  readonly kind: 'servers' | 'reset';
  /** Already parsed (core parseOwnServers); the reset passes the default set. */
  readonly own: readonly string[];
  readonly automatic: boolean;
  readonly announce: boolean;
}

/** What the planner reads of the agent (local-ui serverListPort `state`). */
export interface ServerChangeState {
  readonly relays: readonly string[];
  readonly leaving: readonly LeavingServer[];
  readonly announceDefault: boolean;
  readonly paused: boolean;
  readonly sendState: SendState;
}

/** What the owner reviews before the gesture (hosts only, fixed codes). */
export interface ServerChangeReview {
  readonly kind: 'servers' | 'reset';
  readonly servers: readonly {
    readonly host: string;
    readonly role: 'own' | 'automatic';
    readonly outcome: TestedServer['outcome'];
  }[];
  readonly leaving: readonly { readonly host: string; readonly until: number }[];
  readonly contacts: number;
  readonly warnings: readonly ServerListWarning[];
}

export type ServerPlanRefusalReason =
  | 'agent_paused'
  | 'rotation_pending'
  | 'not_applied'
  | 'same_list'
  | 'mix_in_on'
  | 'not_ready'
  | 'too_many_previous'
  | 'busy';

export type ServerPlanResult =
  | {
      readonly status: 'ok';
      readonly plan: ServerListPlan;
      readonly review: ServerChangeReview;
    }
  | {
      readonly status: 'refused';
      readonly reason: ServerPlanRefusalReason;
      /** `too_many_previous` only: the unix second from which the change fits. */
      readonly fitsAt?: number;
    };

/**
 * Tests the own servers and (with the mix-in) the default set, in one budgeted run: one result per
 * address, in order, or `busy` when the caller's budget refuses it.
 */
export type ServerTestRun = (
  own: readonly string[],
  withDefaults: boolean,
) => Promise<readonly [readonly PrecheckResult[], readonly PrecheckResult[]] | 'busy'>;

const refused = (reason: ServerPlanRefusalReason, fitsAt?: number): ServerPlanResult =>
  Object.freeze({ status: 'refused', reason, ...(fitsAt === undefined ? {} : { fitsAt }) });

/** The origin host (`:port` only when not 443): never a path, query or credential. */
export const serverHost = (url: string): string => relayOrigin(url).slice('wss://'.length);

export const sameServerList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Nothing would change: the same list in the same order and the same announce choice. */
export const planUnchanged = (plan: ServerListPlan, state: ServerChangeState): boolean =>
  sameServerList(plan.relays, state.relays) && plan.announceDefault === state.announceDefault;

/** Two plans of the same ask that tested alike (the app's confirm against its review). */
export const samePlan = (a: ServerListPlan, b: ServerListPlan): boolean =>
  sameServerList(a.relays, b.relays) &&
  a.announceDefault === b.announceDefault &&
  a.servers.every((s, i) => s.role === b.servers[i]?.role);

/** The agent's state refusals (before and after presence), else undefined. */
export function serverStateRefusal(
  state: ServerChangeState,
): 'agent_paused' | 'rotation_pending' | 'not_applied' | undefined {
  if (state.paused) return 'agent_paused';
  if (state.sendState === 'rotation_pending' || state.sendState === 'key_epoch_mismatch') {
    return 'rotation_pending';
  }
  if (state.sendState !== 'ready') return 'not_applied';
  return undefined;
}

const outcomeOf = (r: PrecheckResult | undefined): TestedServer['outcome'] =>
  r === undefined ? 'refused' : r.outcome;

/** Tests the own servers again (and the default set for the mix-in), then builds the plan. */
async function tested(
  ask: ServerChangeAsk,
  test: ServerTestRun,
): Promise<ServerListPlan | ServerPlanResult> {
  if (ask.kind === 'reset') return automaticServerPlan();
  if (ask.automatic && !ask.announce) return refused('mix_in_on');
  // IR L3 (04 §2.5.1, D-158 (7)): the opt-out only while the list holds no default server, also
  // one the owner typed as an own server (NET-ANNOUNCE-OPTOUT: or an old default server).
  if (!ask.announce && holdsDefaultServer(ask.own)) return refused('mix_in_on');
  const ran = await test(ask.own, ask.automatic);
  if (ran === 'busy') return refused('busy');
  const [own, defaults] = ran;
  const built = buildServerList({
    own: ask.own.map((url, i) => ({
      url,
      outcome: outcomeOf(own[i]),
      paid: own[i]?.paymentRequired === true,
    })),
    automatic: ask.automatic,
    announce: ask.announce,
    defaults: AUTOMATIC_SERVERS.map((url, i) => ({
      url,
      outcome: outcomeOf(defaults[i]),
      paid: defaults[i]?.paymentRequired === true,
    })),
  });
  if (built.status === 'refused') return refused(built.reason);
  return built.plan;
}

/**
 * Every check before the gesture, then the tested plan with its review. `now` is unix seconds;
 * `contacts` counts the active, paired contacts a change tells. Throws only what its reads throw.
 */
export async function planServerChange(input: {
  readonly ask: ServerChangeAsk;
  readonly state: ServerChangeState;
  readonly contacts: () => Promise<number>;
  readonly now: number;
  readonly test: ServerTestRun;
}): Promise<ServerPlanResult> {
  const { ask, state } = input;
  const stateRefused = serverStateRefusal(state);
  if (stateRefused !== undefined) return refused(stateRefused);
  if (ask.kind === 'reset' && isAutomaticList(state.relays) && state.announceDefault) {
    return refused('same_list');
  }
  if (
    ask.kind === 'servers' &&
    !ask.automatic &&
    ask.announce === state.announceDefault &&
    sameServerList(ask.own, state.relays)
  ) {
    return refused('same_list');
  }
  const plan = await tested(ask, input.test);
  if ('status' in plan) return plan;
  if (planUnchanged(plan, state)) return refused('same_list');
  const leaving = planLeaving(state.leaving, state.relays, plan.relays, input.now);
  if (leaving.status === 'refused') return refused('too_many_previous', leaving.fitsAt);
  const contacts = await input.contacts();
  return Object.freeze({
    status: 'ok',
    plan,
    review: Object.freeze({
      kind: ask.kind,
      servers: Object.freeze(
        plan.servers.map((s) =>
          Object.freeze({ host: serverHost(s.url), role: s.role, outcome: s.outcome }),
        ),
      ),
      leaving: Object.freeze(
        leaving.leaving.map((e) => Object.freeze({ host: serverHost(e.url), until: e.until })),
      ),
      contacts,
      warnings: Object.freeze([...plan.warnings]),
    }),
  });
}
