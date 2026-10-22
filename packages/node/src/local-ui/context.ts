// M1-11s-b: what every local UI API handler gets (08 §1; D-118; I-4).
//
// One `LocalUiContext` per approval server, shared by every route. It holds read access to the
// agent's core (a read-only client view, LocalUiReadClient), the owner the agent card names, and core's
// `ownerActions.apply`, which verifies an owner signature before anything changes (I-4). There is
// no signing here: an owner operation is reached only through the per-request
// `LocalUiOwnerOperation` that the central presence gate hands to a `presence: true` route
// (route-types.ts). Policy is read and changed the same way (read through the client, changed by a
// signed `policy.set` applied by core).
import type {
  ActivityEntry,
  AgentLinkClient,
  OwnerActionOutcome,
  Page,
  PageQuery,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { ApprovalContext } from '../owner-approval.js';

/**
 * The local UI's built files (apps/local-ui, D-118), in memory, from the caller (the CLI embeds
 * them in its bundle). Keys are `index.html` or `assets/<name>`, `<name>` being one file name with a
 * known extension; anything else fails the server start. Nothing is read from disk.
 */
export interface LocalUiAssets {
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** What the caller wires into the local UI (approval-server.ts `ApprovalServerOptions.localUi`). */
export interface LocalUiOptions {
  /** The app's files; absent or empty: the app pages answer 404 (the approval page still works). */
  readonly assets?: LocalUiAssets;
  /** The agent's core client; absent when the agent is not set up. */
  readonly client?: AgentLinkClient;
}

/**
 * IR-M1-11s-b-1 H-1: the read-only view of the agent's core client that handlers get. It is built
 * by the server as a new object of bound read methods, so a handler cannot reach `sendMessage`,
 * `notarize`, terms, the store or the KeyStore (not even through a cast). A page card that needs
 * another read adds it here (S2 review); a change is always a signed owner action applied by core.
 */
export interface LocalUiReadClient {
  readonly agentId: string;
  getProof(
    input: Parameters<AgentLinkClient['getProof']>[0],
  ): ReturnType<AgentLinkClient['getProof']>;
  /** M1-11c-a1: one page of core's activity feed (`ActivityService.list`); store only, no write. */
  listActivity(query: PageQuery): Promise<Page<ActivityEntry>>;
}

/** The read-only view of `client` (a fresh frozen object, nothing else of the client). */
export function readOnlyClient(client: AgentLinkClient): LocalUiReadClient {
  return Object.freeze<LocalUiReadClient>({
    agentId: client.agentId,
    getProof: (input) => client.getProof(input),
    listActivity: (query) => client.activity.list(query),
  });
}

export interface LocalUiContext {
  /** Read-only access to the agent's core; undefined when not set up. */
  readonly client: LocalUiReadClient | undefined;
  /** The agent and its owner; undefined when no identity or owner is set up. */
  ownerContext(): Promise<ApprovalContext | undefined>;
  /** core `ownerActions.apply`: verifies the owner signature, then applies (I-4). */
  applyOwnerAction(signed: {
    readonly body: JsonObject;
    readonly sig: string;
  }): Promise<OwnerActionOutcome>;
  /** The clock in milliseconds. */
  now(): number;
}
