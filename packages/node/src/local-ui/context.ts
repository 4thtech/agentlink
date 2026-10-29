// M1-11s-b: what every local UI API handler gets (08 §1; D-118; I-4).
//
// One `LocalUiContext` per approval server, shared by every route. It holds read access to the
// agent's core (a read-only client view, LocalUiReadClient), the owner the agent card names, and core's
// `ownerActions.apply`, which verifies an owner signature before anything changes (I-4). There is
// no signing here: an owner operation is reached only through the per-request
// `LocalUiOwnerOperation` that the central presence gate hands to a `presence: true` route
// (route-types.ts). Policy is read and changed the same way (read through the client, changed by a
// signed `policy.set` applied by core).
import {
  CoreError,
  acceptInviteAction,
  decodeInviteLink,
  evaluate,
  type AcceptInviteAction,
  type PendingContact,
  type PolicyDecision,
} from '@4thtech-io/core';
import type {
  ActivityEntry,
  AgentLinkClient,
  ContactView,
  Conversation,
  CreditsMoveResult,
  CreditsView,
  EffectivePolicy,
  ExchangeTimes,
  FlowEvents,
  MessageBox,
  MessageItem,
  OwnerActionOutcome,
  OwnerSafetyCode,
  Page,
  PageQuery,
  PolicyEditOptions,
  LabelReading,
  PreparedOwnerAction,
  PreparedPolicyEdit,
  ProofListItem,
  ReceivedFileItem,
  ResolvedFolders,
  SentFileItem,
  TopUpView,
} from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import type { ApprovalContext } from '../owner-approval.js';
import type { FirstAgentCard } from '../owner-first-card.js';
import type { SendFolderPlan } from '../owner-first-policy.js';
import type { LocalUiHealthBody, LocalUiHealthSource } from './api/health.js';
import type { LocalUiInviteDesk } from './route-types.js';
import type { JoinDesk } from './join-desk.js';

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
  /**
   * M1-11s-a-d: the agent's in-process health state for `GET /api/ui/health` (api/health.ts): agent
   * running or paused, relay counts and the last sync time. Read at most once per cache window and
   * within a time limit; only the allowlisted fields are answered. Absent: an opened agent answers
   * `running`.
   */
  readonly health?: LocalUiHealthSource;
  /** M1-11s-a-d: the app version the health read answers (a plain version, else nothing). */
  readonly version?: string;
  /**
   * U3-f (08 §1 "AI apps"; 06 §7 "The app as a second path"): the CLI's harness desk, the one writer
   * of AI app configs (apps/cli/src/harness/app-desk.ts). Absent: the AI apps routes answer
   * `not_available`.
   */
  readonly aiApps?: LocalUiAiApps;
}

/**
 * U3-f: what an AI app's `agentlink` entry is (entry-only, 08 §1): none, exactly AgentLink's for a
 * local agent name, one AgentLink did not write (nothing of it is ever passed on), or a file that
 * cannot be read (a link, too large, not valid, another form).
 */
export type LocalUiAiAppEntryState =
  | { readonly kind: 'none' }
  | { readonly kind: 'agent'; readonly agent: string }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unreadable' };

/** U3-f: one detected AI app. Fixed names and display paths only; never file content. */
export interface LocalUiAiAppView {
  /** The id of the fixed harness table (06 §7). */
  readonly app: string;
  /** Its fixed display name. */
  readonly name: string;
  /** The config file as shown (`~/…`), from the fixed table. */
  readonly path: string;
  readonly state: LocalUiAiAppEntryState;
  /** Claude Desktop runs now: it is not written ("Quit Claude Desktop first"). */
  readonly quitFirst: boolean;
}

/** U3-f: how a planned write ended. */
export type LocalUiAiAppWrite =
  | 'written'
  /** The file is not the one planned (bytes or identity): nothing written. */
  | 'changed'
  /** Claude Desktop runs: nothing written. */
  | 'quit_first'
  /** The agent the entry runs is not the agent the owner signed for: nothing written. */
  | 'agent_mismatch'
  | 'failed';

/**
 * U3-f: the exact entry change for one app and one agent, or why there is none. `file` is the
 * resolved config path (bound by the `changeId`, never answered); `identity` is the file's device
 * and inode as read (`none` when it does not exist). `commit` writes exactly this change (atomic,
 * with a mode-keeping backup) after checking again that the file is unchanged, Claude Desktop is
 * not running and the entry's agent is `agentId`'s folder.
 */
export type LocalUiAiAppPlan =
  | {
      readonly status: 'change';
      readonly kind: 'connect' | 'move' | 'disconnect';
      readonly app: string;
      readonly name: string;
      readonly path: string;
      readonly file: string;
      readonly oldEntry: JsonObject | null;
      readonly newEntry: JsonObject | null;
      readonly oldAgent: string | null;
      readonly newAgent: string | null;
      readonly identity: string;
      commit(agentId: string): Promise<LocalUiAiAppWrite>;
    }
  | {
      readonly status:
        'present' | 'not_connected' | 'conflict' | 'quit_first' | 'unreadable' | 'not_found';
      readonly app: string;
      readonly name: string;
    };

/**
 * U3-f: the harness seam the CLI passes in (06 §7: one writer; packages/node builds no config path
 * and writes no config). Every method checks the app id and the agent name itself and never throws
 * with file content.
 */
export interface LocalUiAiApps {
  /** The detected apps, entry-only, and whether Claude Desktop runs. */
  list(): Promise<{ readonly apps: readonly LocalUiAiAppView[]; readonly desktopRunning: boolean }>;
  /**
   * The change that makes `app` run `agent` (connect, or move from another agent), or, when it
   * already runs `agent`, the change that disconnects it.
   */
  plan(app: string, agent: string): Promise<LocalUiAiAppPlan>;
  /** The agentId recorded for an agent folder (07 §9.1); undefined when it cannot be read. */
  agentIdOf(agent: string): Promise<string | undefined>;
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
    /** M1-11c-a4c: where funds can be sent to add credits, and what can move (reads only). */
    topUp(): Promise<TopUpView>;
  };
  /** M1-11c-a1: one page of core's activity feed (`ActivityService.list`); store only, no write. */
  listActivity(query: PageQuery): Promise<Page<ActivityEntry>>;
  /**
   * MSG-FILES-IO-c (Messages, D-133): core's read-only MessagesView (MSG-FILES-IO-a): the contact
   * list and one contact's Inbox or Sent. Store only; it writes nothing and never sets `read_at`, so
   * the app never marks a message read for the AI (I-4). Nothing else of the view or the inbox.
   */
  readonly messages: {
    conversations(): Promise<readonly Conversation[]>;
    list(contactId: string, box: MessageBox, query: PageQuery): Promise<Page<MessageItem>>;
    /**
     * UX2-f1 (b11 §24): who exchanged messages when, in a window (core `MessagesView.pulseTimes`):
     * a contact ID and a time each, never content. Store only, bounded, writes nothing.
     */
    pulseTimes(since: number, until: number): Promise<ExchangeTimes>;
    /**
     * U3-flow (USABILITY-WAVE-3 §4.1): who exchanged a message or file when, which way and in what
     * state, in a window (core `MessagesView.flowEvents`): metadata only, never content, names,
     * links, keys, hashes or envelope IDs. Store only, bounded, writes nothing.
     */
    flowEvents(since: number, until: number): Promise<FlowEvents>;
  };
  /**
   * MSG-FILES-IO-d (Files, Received and Sent): one page of core's `FilesIoView`, store only. Never
   * fetches, opens or hashes a file and never writes (I-4); not `fetchFile`, not the store.
   * MSG-FILES-IO-h: `savedName`, one received item's saved name by item ID (core
   * `FilesIoView.savedName`), for Show in Finder only; never log it (I-7).
   */
  readonly filesIo: {
    received(query: PageQuery): Promise<Page<ReceivedFileItem>>;
    sent(query: PageQuery): Promise<Page<SentFileItem>>;
    savedName(itemId: string): Promise<string | null>;
  };
  /**
   * U3-d (D-138; 04 §2.5.1 `agent.label`): the agent's verified label (core `loadLabel`: the stored
   * `agent.label`, re-verified on every load) and core's prepare helper for a new one. Both write
   * nothing (I-4): a prepared body changes nothing until the gate's one-use `sign` signed it and core
   * applied it. Optional so that page fakes without it stay valid; the server always sets it.
   */
  readonly agent?: {
    label(): Promise<LabelReading>;
    prepareLabel(label: string): Promise<PreparedOwnerAction>;
  };
  /**
   * U3-f (04 §2.5.1 `app.connect`, `app.disconnect`): core's prepare helper for an AI app change of
   * this agent. Writes nothing (I-4): the body changes nothing until the gate's one-use `sign`
   * signed it and core applied it. Optional so that page fakes without it stay valid.
   */
  readonly apps?: {
    prepare(
      op: 'app.connect' | 'app.disconnect',
      app: string,
      changeId: string,
    ): Promise<PreparedOwnerAction>;
  };
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
      topUp: () => client.proofs.receiveOptions(),
    }),
    listActivity: (query) => client.activity.list(query),
    // MSG-FILES-IO-c: the Messages reads only.
    messages: Object.freeze({
      conversations: () => client.messages.conversations(),
      list: (contactId: string, box: MessageBox, query: PageQuery) =>
        client.messages.list(contactId, box, query),
      // UX2-f1: the activity pulse's exchange times.
      pulseTimes: (since: number, until: number) => client.messages.pulseTimes(since, until),
      // U3-flow: the live connections map's flow events.
      flowEvents: (since: number, until: number) => client.messages.flowEvents(since, until),
    }),
    filesIo: Object.freeze({
      received: (query: PageQuery) => client.filesIo.received(query),
      sent: (query: PageQuery) => client.filesIo.sent(query),
      savedName: (itemId: string) => client.filesIo.savedName(itemId),
    }),
    // U3-d: the verified label and the unsigned `agent.label` (reads and prepare only).
    agent: Object.freeze({
      label: () => client.ownerActions.loadLabel(),
      prepareLabel: (label: string) => client.ownerActions.prepareLabel(label),
    }),
    // U3-f: the unsigned `app.connect` / `app.disconnect` (prepare only).
    apps: Object.freeze({
      prepare: (op: 'app.connect' | 'app.disconnect', app: string, changeId: string) =>
        client.ownerActions.prepareAppChange(op, app, changeId),
    }),
  });
}

/**
 * M1-11c-a4c: the two credits moves, for `presence: true` routes only. Each takes an owner-signed
 * object that the route's one-use owner operation produced (the presence gate ran first); core
 * verifies the owner signature, the op and its rules again before anything is sent (I-4). Nothing
 * else of the client is reachable through it.
 */
export interface LocalUiCreditsPort {
  addReceivedFunds(signed: {
    readonly body: JsonObject;
    readonly sig: string;
  }): Promise<CreditsMoveResult>;
  withdrawCredits(signed: {
    readonly body: JsonObject;
    readonly sig: string;
  }): Promise<CreditsMoveResult>;
}

/** The credits port over `client` (a fresh frozen object of two bound methods). */
export function creditsPort(client: AgentLinkClient): LocalUiCreditsPort {
  return Object.freeze<LocalUiCreditsPort>({
    addReceivedFunds: (signed) => client.proofs.addReceivedFunds(signed),
    withdrawCredits: (signed) => client.proofs.withdrawCredits(signed),
  });
}

/**
 * UX2-d1: the invite desk of the `presence: 'invite'` routes over `client` (a fresh frozen object):
 * core `createInvite`, and core's accept step 1 with the link's expiry. Nothing here signs, pairs,
 * stores a pairing or logs the link (I-7); `check` stores nothing at all.
 */
export function inviteDesk(client: AgentLinkClient): LocalUiInviteDesk {
  return Object.freeze<LocalUiInviteDesk>({
    create: (input) => client.pairing.createInvite(input),
    async check(link) {
      const checked = await client.pairing.acceptInvite({ link });
      // The same codec again for the expiry only (the link was just decoded and checked above).
      const { expiresAt } = await decodeInviteLink(link);
      return Object.freeze({ contact: checked.contact, expiresAt });
    },
  });
}

/** UX2-d1: how accepting ended after the owner's decision was applied. */
export type LocalUiAcceptOutcome =
  | {
      readonly status: 'started';
      readonly contact: PendingContact;
      /** False when the handshake could not be sent yet (the outbox keeps it for later). */
      readonly sent: boolean;
    }
  /** Core would not use the approval (void, expired, denied, or the rule is now `deny`). */
  | { readonly status: 'refused' };

/**
 * UX2-d1: accepting an invite, for the `presence: true` accept route only (04 §3.6 Accept; 06 §2.1).
 * Each step is core's own: the codec and step 1 (`check`), the `contacts.acceptInvites` decision, the
 * one accept action (`action`, shared with the MCP tool and the CLI), the owner request for it
 * (`openRequest`: the open pending one for that same action, or a new one). `acceptApproved` pairs
 * only through core's `use` of an approval the owner signed and core applied (I-4): it never sets
 * `allowed` from anything else, so nothing here can pair without the owner's verified decision.
 */
export interface LocalUiInviteAcceptPort {
  check(link: string): Promise<PendingContact>;
  decision(): Promise<PolicyDecision>;
  action(link: string): Promise<AcceptInviteAction>;
  openRequest(
    action: AcceptInviteAction,
    summary: string,
  ): Promise<{ readonly approvalId: string; readonly expiresAt: number }>;
  acceptApproved(
    link: string,
    approvalId: string,
    action: AcceptInviteAction,
  ): Promise<LocalUiAcceptOutcome>;
}

/** Core errors that only mean "the outbox could not publish right now" (as the MCP tool). */
const OFFLINE_CODES: ReadonlySet<string> = new Set(['transport_unavailable']);

/** The accept port over `client` (a fresh frozen object of bound core calls). */
export function inviteAcceptPort(client: AgentLinkClient): LocalUiInviteAcceptPort {
  const decision = async (): Promise<PolicyDecision> =>
    evaluate(await client.ownerActions.loadPolicy(), { kind: 'invite.accept' });
  return Object.freeze<LocalUiInviteAcceptPort>({
    async check(link) {
      return (await client.pairing.acceptInvite({ link })).contact;
    },
    decision,
    action: (link) => acceptInviteAction(link),
    async openRequest(action, summary) {
      const open = await client.approvalService.findOpen(action);
      if (open?.status === 'pending') {
        return { approvalId: open.approvalId, expiresAt: open.expiresAt };
      }
      const pending = await client.approvalService.request({ action, summary });
      return { approvalId: pending.approvalId, expiresAt: pending.expiresAt };
    },
    async acceptApproved(link, approvalId, action) {
      // Policy is evaluated again at use (04 §3.4.1): a rule now `deny` refuses it.
      const used = await client.approvalService.use(approvalId, action, await decision());
      if (used.status !== 'used') return { status: 'refused' };
      const started = await client.pairing.acceptInvite({ link, allowed: true });
      // `allowed` was set, so this does not happen; fail closed if it ever does.
      if (started.status !== 'pending') {
        throw new CoreError('approval_action_invalid', 'The pairing could not be started.');
      }
      let sent = false;
      try {
        const summary = await client.outbox.processDue();
        sent = summary.sent > 0 && summary.failed === 0 && summary.notDelivered === 0;
      } catch (error) {
        if (!(error instanceof CoreError) || !OFFLINE_CODES.has(error.code)) throw error;
      }
      return { status: 'started', contact: started.contact, sent };
    },
  });
}

export interface LocalUiContext {
  /**
   * U3-g-b: present only while the app host has no agent yet: true when first run cannot set up an
   * owner here (an owner or any agent folder exists). `GET /api/ui/first-run` answers from it.
   */
  readonly setupBlocked?: () => Promise<boolean>;
  /** Read-only access to the agent's core; undefined when not set up. */
  readonly client: LocalUiReadClient | undefined;
  /** M1-11c-a4c: the credits moves for the owner routes; undefined when not set up. */
  readonly credits?: LocalUiCreditsPort;
  /**
   * UX2-d1: accepting an invite, for the accept owner route only; undefined when not set up. Its
   * pairing step runs only after core used an owner-signed, applied approval (I-4).
   */
  readonly invites?: LocalUiInviteAcceptPort;
  /** The agent and its owner; undefined when no identity or owner is set up. */
  ownerContext(): Promise<ApprovalContext | undefined>;
  /** core `ownerActions.apply`: verifies the owner signature, then applies (I-4). */
  applyOwnerAction(signed: {
    readonly body: JsonObject;
    readonly sig: string;
  }): Promise<OwnerActionOutcome>;
  /** The clock in milliseconds. */
  now(): number;
  /**
   * M1-11s-a-d: the bounded, cached health read (api/health.ts createHealthReader). Fixed fields
   * only; never rejects.
   */
  readonly health?: () => Promise<LocalUiHealthBody>;
  /**
   * U3-c (D-138, 08 §1): the Agents list of the app host, for `GET /api/ui/agents` only; absent
   * outside the app host (an approval page opened by an MCP process stays bound to its agent). Reads
   * only: it lists, it never opens, switches or writes.
   */
  readonly agents?: LocalUiAgentsDesk;
  /**
   * U3-d (D-138, 08 §1): creating an agent and saving a verified label, for the owner routes of
   * api/agents-manage.ts only; absent outside the app host. It signs nothing: a new agent's first
   * parts are signed only through the gate's one-use `addAgent`, and a label is written into
   * config.json only after core applied the signed `agent.label` (07 §9.1).
   */
  readonly agentsManage?: LocalUiAgentsManage;
  /**
   * U3-invite (08 §4): the app host's waiting invite, for the join routes only (api/join.ts);
   * absent outside the app host. It holds the link in memory and answers the screen only the state,
   * the public inviteId and the display fields; it signs nothing.
   */
  readonly join?: JoinDesk;
  /**
   * U3-invite-b (06 §6, 08 §4; proposed): one short pass for the join screen while it waits for the
   * inviter's answer, only when no other process holds the agent's publisher lease (it takes the
   * lease, fetches and processes, delivers due rows and releases it). In the app host only; never
   * throws (local-ui/pairing-follow.ts).
   */
  readonly followPairing?: () => Promise<unknown>;
  /**
   * U3-f (08 §1 "AI apps"): the CLI's harness desk for the AI apps routes (api/apps.ts) only. It
   * writes only through a plan's `commit`, which the apply and disconnect routes call after the
   * owner signed the change and core applied it.
   */
  readonly aiApps?: LocalUiAiApps;
}

/** U3-c: one agent in `GET /api/ui/agents`. Never a path, an agent ID or a key. */
export interface LocalUiAgentView {
  readonly name: string;
  /** Plain text: the owner's label from config.json (display only), else the name. */
  readonly label: string;
  /** A verified `agent.label` exists (U3-d); false: shown under its folder name. */
  readonly labelled: boolean;
  readonly current: boolean;
  /** False when the agent's config cannot be read: listed, never opened. */
  readonly available: boolean;
  /** "Removal not finished" (07 §9.1 `removing`, or in the owner's revoked list). */
  readonly removing: boolean;
  /** Active contacts; null when the store cannot be read just now. */
  readonly contacts: number | null;
  /** An AI app is running this agent (the publisher lease row, read only, 06 §6). */
  readonly running: boolean;
  /** The AI app ids whose `agentlink` entry runs this agent (U3-f: from the entry only). */
  readonly apps: readonly string[];
}

/** U3-c: the body of `GET /api/ui/agents` in the app host. */
export interface LocalUiAgentsList {
  readonly generation: number;
  /** The open agent's name and label; null when none could be opened. */
  readonly current: string | null;
  readonly label: string | null;
  readonly agents: readonly LocalUiAgentView[];
}

/** U3-c: what the agents read route may call (built by the server over the app host). */
export interface LocalUiAgentsDesk {
  list(): Promise<LocalUiAgentsList>;
}

/**
 * U3-d: an agent this request created (keychain identity and folder, no card, no label yet), opened
 * for its first parts. Built by the server only; a handler passes it on to the gate's `addAgent` and
 * then to `settle`, and never reaches its core or its KeyStore through it.
 */
export interface LocalUiNewAgent {
  /** Its folder name (a slug of the label, 06 §6). */
  readonly name: string;
  /** The label the page showed, as the request carried it. */
  readonly label: string;
  /** The agent's own card parts and core actions (server-held). */
  readonly first: FirstAgentCard;
  /** The Send folder for its first policy, checked before the gesture (owner-first-policy.ts). */
  readonly plan: SendFolderPlan;
}

/** U3-d: what the create and rename routes may call (built by the server over the app host). */
export interface LocalUiAgentsManage {
  /** The open agent's folder name; undefined when none is open. */
  current(): string | undefined;
  /** Creates a keychain agent named from `label` and opens it; undefined when that failed. */
  create(label: string): Promise<LocalUiNewAgent | undefined>;
  /**
   * Closes the new agent; when `ok` is false, removes exactly what `create` made (its keychain items
   * and its folder), all or nothing. Never throws.
   */
  settle(agent: LocalUiNewAgent, ok: boolean): Promise<void>;
  /** After core applied the signed `agent.label`: writes config.json `label` (07 §9.1). */
  labelSaved(name: string, label: string): Promise<void>;
}
