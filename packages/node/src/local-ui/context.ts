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
  MessageBox,
  MessageItem,
  OwnerActionOutcome,
  OwnerSafetyCode,
  Page,
  PageQuery,
  PolicyEditOptions,
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
import type { LocalUiHealthBody, LocalUiHealthSource } from './api/health.js';
import type { LocalUiInviteDesk } from './route-types.js';

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
    }),
    filesIo: Object.freeze({
      received: (query: PageQuery) => client.filesIo.received(query),
      sent: (query: PageQuery) => client.filesIo.sent(query),
      savedName: (itemId: string) => client.filesIo.savedName(itemId),
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
}
