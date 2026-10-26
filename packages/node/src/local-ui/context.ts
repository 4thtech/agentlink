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
  ContactView,
  CreditsView,
  EffectivePolicy,
  OwnerActionOutcome,
  OwnerSafetyCode,
  Page,
  PageQuery,
  PolicyEditOptions,
  PreparedOwnerAction,
  PreparedPolicyEdit,
  ProofListItem,
  ResolvedFolders,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { ApprovalContext } from '../owner-approval.js';
import type { FirstAgentCard } from '../owner-first-card.js';

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
  /**
   * M1-11s-c: owner setup on the first-run page (D-120 (1)), for a keychain agent that has no owner
   * yet: the agent whose first card the setup signs. Held by the server only, never by a handler or
   * LocalUiContext. Absent: the setup routes answer 503 `unavailable`.
   */
  readonly ownerSetup?: LocalUiOwnerSetup;
}

/** M1-11s-c: what owner setup needs from the caller (the CLI). Keychain machines only. */
export interface LocalUiOwnerSetup {
  /** The agent whose first card the new owner signs (owner-first-card.ts). */
  readonly firstCard: FirstAgentCard;
  /**
   * IR-M1-11s-c-1 L-6: the file-KeyStore owner files whose presence refuses setup. Default:
   * `~/.agentlink/keystore/owner.alko` and `owner.alkp` (owner-setup.ts defaultOwnerFiles).
   */
  readonly ownerFiles?: readonly string[];
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
  /**
   * M1-11c-a5 (Rules): the policy in force and the unsigned `policy.set` for an edit (core
   * `loadPolicy` and `preparePolicyEdit`, M1-11r-b). Both sign, write and grant nothing (I-4): a
   * prepared body changes nothing until the owner signs it behind the presence gate and core's
   * `apply` verifies that signature. `recordReceiptsKept` writes only core's receipts-kept marker,
   * and only for the verified, applied policy at that version with receipts on (D-109): it grants
   * nothing the signed policy does not already say. Not `apply`, not the store, not the KeyStore.
   */
  readonly policy: {
    load(): Promise<EffectivePolicy>;
    prepareEdit(patch: unknown, options: PolicyEditOptions): Promise<PreparedPolicyEdit>;
    recordReceiptsKept(version: number): Promise<boolean>;
  };
  /**
   * M1-11c-a3 (Files): the allowed folders as the rules write them and their realpaths (display
   * paths only), and the unsigned `policy.set` for a folder edit (D-118). Both write nothing; the
   * body is signed only behind the presence gate and applied by core (I-4). Not `apply`, not
   * `recordReceiptsKept`, nothing else of `ownerActions`.
   */
  readonly files: {
    resolvedFolders(): Promise<ResolvedFolders>;
    preparePolicyEdit(patch: unknown, options?: PolicyEditOptions): Promise<PreparedPolicyEdit>;
  };
  /**
   * M1-11c-a2 (Contacts): the contact list, the safety code recomputed for the owner surface (04
   * §3.6.1) and core's prepare helpers for `contact.check`, `contact.rename` and `contact.remove`
   * (#415). Each prepare builds an unsigned body and writes nothing (I-4); only a signature from the
   * gate's one-use `sign`, applied by core, changes anything. No direct block, remove or apply.
   */
  readonly contacts: {
    list(): Promise<readonly ContactView[]>;
    safetyCode(contactId: string): Promise<OwnerSafetyCode>;
    prepareCheck(contactId: string): Promise<PreparedOwnerAction>;
    prepareRename(contactId: string, alias: string): Promise<PreparedOwnerAction>;
    prepareRemove(contactId: string): Promise<PreparedOwnerAction>;
  };
  /**
   * M1-11c-a4 (Proofs and credits): the proof list and the credits read, both store or chain reads
   * only. Not `requestFaucet` (owner decision D2) and nothing that notarizes.
   */
  readonly proofs: {
    list(query: PageQuery): Promise<Page<ProofListItem>>;
    creditsBalance(): Promise<CreditsView>;
  };
  /** M1-11c-a1: one page of core's activity feed (`ActivityService.list`); store only, no write. */
  listActivity(query: PageQuery): Promise<Page<ActivityEntry>>;
}

/** The read-only view of `client` (a fresh frozen object, nothing else of the client). */
export function readOnlyClient(client: AgentLinkClient): LocalUiReadClient {
  return Object.freeze<LocalUiReadClient>({
    agentId: client.agentId,
    getProof: (input) => client.getProof(input),
    policy: Object.freeze({
      load: () => client.ownerActions.loadPolicy(),
      prepareEdit: (patch: unknown, options: PolicyEditOptions) =>
        client.ownerActions.preparePolicyEdit(patch, options),
      recordReceiptsKept: (version: number) => client.ownerActions.recordReceiptsKept(version),
    }),
    files: Object.freeze({
      resolvedFolders: () => client.files.resolvedFolders(),
      preparePolicyEdit: (patch: unknown, options?: PolicyEditOptions) =>
        client.ownerActions.preparePolicyEdit(patch, options),
    }),
    contacts: Object.freeze({
      list: () => client.contacts.list(),
      safetyCode: (contactId: string) => client.pairing.ownerSafetyCode(contactId),
      prepareCheck: (contactId: string) => client.ownerActions.prepareContactCheck(contactId),
      prepareRename: (contactId: string, alias: string) =>
        client.ownerActions.prepareContactRename(contactId, alias),
      prepareRemove: (contactId: string) => client.ownerActions.prepareContactRemove(contactId),
    }),
    proofs: Object.freeze({
      list: (query: PageQuery) => client.proofs.list(query),
      creditsBalance: () => client.proofs.creditsBalance(),
    }),
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
