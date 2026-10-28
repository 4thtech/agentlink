// U3-e: removing an agent from the local app (08 §1 `POST /api/ui/agents/remove`; 04 §2.5 "Removing
// an agent", §2.5.1 `agent.revoke` and "The owner's revoked list", §2.3.3; 06 §6 "Open agents and
// removal"; 07 §9.1; D-58, D-138; I-1, I-2, I-4, I-7, I-10).
//
// The route is its own kind, `presence: 'remove'`, run by the server's remove gate
// (approval-server.ts removeGate): it needs the in-use check and the agent's folder lock around the
// owner's gesture, and its owner context comes from the agent being removed (which may not be the
// agent the app has open, for example a "Removal not finished" agent, which is never opened). This
// file holds what the gate runs: the strict input, the seam the CLI provides (the folder lock, the
// agent opened for its removal, the revoked list), the statement shown before the gesture, and the
// steps after it.
//
// Order (04 §2.5, steps 1 to 7): (1) the app closes the agent if it has it open, then takes the
// folder lock EXCLUSIVE, which fails at once with `in_use` while any other process has the agent
// open (every `agentlink mcp` server and the app host hold it shared); the lock is held from before
// the gesture to after the folder is deleted, so it is held through step 3 and again (still) right
// before deleting. (2) The one gesture signs `agent.revoke {reason: "retired"}` for the agent, with
// or without contacts; the signed object's exact text is recorded at once in the owner's revoked
// list (never replaced: an existing entry is kept and is what is sent). (3) `removing: true` is
// written into config.json before anything is sent or deleted. (4) With contacts, the `revoke`
// carriers, signed by the owner key with the same session, go out through the outbox with a bounded
// wait; if they are not delivered the answer is `undeliverable` and nothing more happens ("Remove
// anyway?" with "Remove anyway" / "Not now"); `anyway: true` (a new gesture) goes on. (5) The AI
// app entries that run the agent are removed (card U3-f's seam; without it there are none to
// remove). (6) The keys are erased through the KeyStore erase API (never an owner item). (7) The
// store, config and folder are deleted (agent-dir.ts removeAgentFolder, its realpath rules). Then
// the app opens another agent, or none ("Add an agent"); the owner stays.
//
// The label is display text from config.json: it never authorises anything. What binds the gesture
// to the agent is `agent` in the signed object (the agent's own ID, read from its own store), and the
// folder name in the request must be a listed agent; the statement names the label and the folder.
// I-7: logs and errors say only that an agent was removed or which fixed step failed; never a name,
// label, path, key or ID.
import {
  buildAgentRevokeBody,
  verifyRevokedEntry,
  type AgentLinkClient,
  type RevokeDeliveryOptions,
} from '@4thtech-io/core';
import {
  canonicalize,
  type JsonObject,
  type JsonValue,
  type KeyEraseControl,
} from '@4thtech-io/crypto';
import type { ApprovalContext } from '../../owner-approval.js';
import {
  AGENTS_REMOVE_PATH,
  type LocalUiOwnerOperation,
  type LocalUiRemoveRoute,
  type LocalUiRoute,
} from '../route-types.js';

export { AGENTS_REMOVE_PATH };

export const agentsRemoveRoutes: readonly LocalUiRoute[] = Object.freeze([
  Object.freeze<LocalUiRemoveRoute>({
    method: 'POST',
    path: AGENTS_REMOVE_PATH,
    presence: 'remove',
  }),
]);

/** One agent opened by its removal, inside the exclusive folder lock (never the app's open agent). */
export interface RemovalAgent {
  readonly client: AgentLinkClient;
  /** The agent and the owner its own card names; undefined when it has no identity. */
  context(): Promise<ApprovalContext | undefined>;
  /** Closes the store, the KeyStore and the relay connections. Idempotent. */
  close(): Promise<void>;
}

/** A revoked-list entry as the CLI reads it (agent-dir.ts): the exact text, or damaged. */
export type RevokedListEntry =
  | { readonly kind: 'none' }
  | { readonly kind: 'entry'; readonly text: string }
  | { readonly kind: 'damaged' };

/**
 * The seam the CLI provides for removal (apps/cli/src/commands/ui-remove.ts), over agent-dir.ts and
 * openAgent, so the folder rules stay in one place. Every method checks the name itself; errors are
 * fixed codes, never a path (I-7).
 */
export interface AgentRemovalPort {
  /**
   * Runs `fn` while holding the agent folder's lock EXCLUSIVE (node withAgentFolderExclusive). Throws
   * AgentFolderLockError `in_use` at once while any process has the agent open.
   */
  exclusive<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Opens the agent for its removal. Only inside `exclusive`: it takes no shared lock itself. */
  open(name: string): Promise<RemovalAgent | undefined>;
  /** The agent's ID and recorded backend (config.json), and its keystore folder; undefined if none. */
  keys(name: string): Promise<
    | {
        readonly agentId: string;
        readonly backend: 'keychain' | 'file';
        readonly keystoreDir: string;
      }
    | undefined
  >;
  /** The owner's revoked-list entry for `agentId` (`~/.agentlink/revoked/<agentId>.json`). */
  readRevoked(agentId: string): Promise<RevokedListEntry>;
  /** Records `text` as the entry for `agentId` (0600, never replacing one that exists). */
  recordRevoked(agentId: string, text: string): Promise<void>;
  /**
   * Card U3-f: removes the AI app entries that run this agent (entry-only, 04 §2.5 "Writing AI app
   * configs"). Absent until U3-f lands: no entry is written by the app before it.
   */
  removeAppEntries?(name: string): Promise<void>;
}

/** The strict input of the remove route (`X-AgentLink-Input`). */
export interface RemoveInput {
  readonly name: string;
  readonly typedLabel: string;
  /** "Remove anyway" after `undeliverable` (b11 §29). */
  readonly anyway: boolean;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_LABEL_CHARS = 40;

/** Parses the input: exactly `{name, typedLabel}` plus an optional `anyway: true`; else undefined. */
export function parseRemoveInput(input: JsonValue | undefined): RemoveInput | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, JsonValue>;
  const keys = Object.keys(record).sort();
  const allowed = ['anyway', 'name', 'typedLabel'];
  if (!keys.every((k) => allowed.includes(k)) || !keys.includes('name')) return undefined;
  if (!keys.includes('typedLabel')) return undefined;
  const { name, typedLabel, anyway } = record;
  if (typeof name !== 'string' || !NAME.test(name)) return undefined;
  if (typeof typedLabel !== 'string' || typedLabel.length > MAX_LABEL_CHARS * 2) return undefined;
  if (anyway !== undefined && anyway !== true) return undefined;
  return Object.freeze({ name, typedLabel, anyway: anyway === true });
}

/**
 * The statement shown before the gesture (04 §2.5: it names the agent's label, says it is retired
 * for good and cannot be restored; 11 §5: "keys" only here). The folder is the binding the owner
 * picked; the label is display text.
 */
export function removeStatement(
  label: string,
  folder: string,
  contacts: number,
  anyway = false,
): string[] {
  return [
    `Remove the agent ${label} from this computer for good.`,
    `Agent folder: ${folder}`,
    'Its keys, messages and files on this computer are deleted. It is retired and cannot be restored.',
    contacts === 0
      ? 'It has no contacts to tell.'
      : anyway
        ? "Its contacts can't be told now. It is removed anyway."
        : 'Its contacts are told that it was removed.',
  ];
}

/** The fixed outcomes of the remove route. */
export type RemoveOutcome =
  | 'removed'
  | 'undeliverable'
  | 'in_use'
  | 'label_mismatch'
  | 'unknown_agent'
  | 'agent_changed'
  | 'not_available'
  | 'invalid'
  | 'failed';

/** The HTTP status of each outcome. */
export const REMOVE_STATUS: Readonly<Record<RemoveOutcome, number>> = Object.freeze({
  removed: 200,
  undeliverable: 409,
  in_use: 409,
  label_mismatch: 409,
  unknown_agent: 404,
  agent_changed: 409,
  not_available: 501,
  invalid: 400,
  failed: 500,
});

/**
 * The label the statement names (04 §2.5.1 "Labels"): the agent's verified `agent.label` from its own
 * store (U3-d, core loadLabel), else its folder name. The unsigned config.json label never reaches a
 * presence statement; the folder name is always shown beside it.
 */
export async function statementLabel(client: AgentLinkClient, folder: string): Promise<string> {
  try {
    const reading = await client.ownerActions.loadLabel();
    return reading.status === 'verified' ? reading.label : folder;
  } catch {
    return folder;
  }
}

/** What the steps after the gesture need (the gate builds it inside the exclusive lock). */
export interface RemovalSteps {
  readonly name: string;
  /** The agent ID config.json records for `name`: the opened store must be that agent's. */
  readonly agentId: string;
  readonly label: string;
  readonly anyway: boolean;
  readonly agent: RemovalAgent;
  readonly port: AgentRemovalPort;
  /** Writes `removing: true` into config.json (AgentDirectory.markRemoving). */
  readonly markRemoving: (name: string) => Promise<void>;
  /** Deletes the folder's known files and the folder (AgentDirectory.removeFolder). */
  readonly removeFolder: (name: string) => Promise<void>;
  /** The KeyStore erase API of the agent's recorded backend. */
  readonly erase: KeyEraseControl;
  /** The one-use owner operation of this gesture, with the carrier keys of its session. */
  readonly owner: LocalUiOwnerOperation;
  readonly delivery?: RevokeDeliveryOptions;
  /** Fixed log lines only (I-7). */
  readonly log?: (event: 'removed' | 'step_failed', step?: RemovalStep) => void;
}

/** The fixed steps a failure names (I-7: never a value). */
export type RemovalStep = 'sign' | 'record' | 'mark' | 'tell' | 'apps' | 'keys' | 'folder';

/** A removal step failed; the gate answers `failed` with the fixed step only. */
export class RemovalStepFailed extends Error {
  readonly step: RemovalStep;
  constructor(step: RemovalStep) {
    super('A removal step failed.');
    this.name = 'RemovalStepFailed';
    this.step = step;
  }
}

async function step<T>(name: RemovalStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RemovalStepFailed) throw error;
    throw new RemovalStepFailed(name);
  }
}

/**
 * Runs 04 §2.5 steps 2 to 7 after the presence check, inside the exclusive folder lock. Returns
 * `removed` or `undeliverable`; a failed step throws RemovalStepFailed, and whatever was done stays
 * done: once the revoke is recorded the agent is retired and listed as "Removal not finished" (Try
 * again runs these steps again; each is idempotent).
 */
export async function runRemovalSteps(steps: RemovalSteps): Promise<'removed' | 'undeliverable'> {
  const { name, agent, port, owner } = steps;
  const client = agent.client;
  const facts = await step('sign', () => client.removal.facts());
  // The store opened for `name` is the agent its config records (the folder the owner picked).
  if (facts.agentId !== steps.agentId) throw new RemovalStepFailed('sign');
  // (2) Always signed, with or without contacts; bound to the agent's own ID (never the label).
  const body = await step('sign', () => client.removal.prepareRevoke());
  // A refused or cancelled gesture propagates as it is (the gate answers it).
  const signatures = await owner.sign(
    {
      lines: removeStatement(
        await statementLabel(client, name),
        name,
        facts.contacts,
        steps.anyway,
      ),
    },
    [{ kind: 'owner-action', action: body }],
  );
  const first = signatures[0];
  if (signatures.length !== 1 || first?.kind !== 'owner-action') {
    throw new RemovalStepFailed('sign');
  }
  const signedText = canonicalize(first.signed as unknown as JsonValue);
  if (!verifyRevokedEntry(signedText, facts.agentId, facts.ownerNostr).ok) {
    throw new RemovalStepFailed('sign');
  }
  // Recorded at once; an existing entry is never replaced, and a verifying one is what is sent.
  const recorded = await step('record', async () => {
    const existing = await port.readRevoked(facts.agentId);
    if (existing.kind === 'none') {
      await port.recordRevoked(facts.agentId, signedText);
      const back = await port.readRevoked(facts.agentId);
      if (back.kind !== 'entry' || back.text !== signedText) throw new RemovalStepFailed('record');
      return signedText;
    }
    if (
      existing.kind === 'entry' &&
      verifyRevokedEntry(existing.text, facts.agentId, facts.ownerNostr).ok
    ) {
      return existing.text;
    }
    // A damaged entry stays (fail closed: the agent counts as revoked); this gesture's own revoke
    // is the one sent.
    return signedText;
  });
  // (3) The mark, before anything is sent or deleted.
  await step('mark', () => steps.markRemoving(name));
  // (4) Tell the contacts, only if there are any, with the owner key of this same gesture.
  if (facts.contacts > 0) {
    const keys = owner.carrierKeys?.();
    if (keys === undefined) throw new RemovalStepFailed('tell');
    const ids = await step('tell', () => client.removal.queueCarriers(recorded, keys));
    const delivered = await step('tell', () => client.removal.deliver(ids, steps.delivery));
    if (delivered !== 'delivered' && !steps.anyway) return 'undeliverable';
  }
  // (5) The AI app entries that run this agent (before the keys: a failure stops here).
  const removeEntries = port.removeAppEntries;
  if (removeEntries !== undefined) await step('apps', () => removeEntries.call(port, name));
  // (6) The keys: the storage ids were read first (facts); the store is closed, then erased.
  await agent.close().catch(() => undefined);
  await step('keys', () =>
    steps.erase.eraseAgentKeys({
      agentId: facts.agentId,
      storageIds: facts.storageIds,
      revoke: recorded,
    }),
  );
  // (7) The store, the config and the folder.
  await step('folder', () => steps.removeFolder(name));
  steps.log?.('removed');
  return 'removed';
}

/** What finishing a removal whose keys are already gone needs (04 §2.5 steps 6 and 7 only). */
export interface FinishSteps {
  readonly name: string;
  readonly label: string;
  /** The agent ID config.json records; its revoked-list entry must verify for it. */
  readonly agentId: string;
  /** The verifying revoked-list entry (the agent is retired for good). */
  readonly recorded: string;
  /** The owner key the entry is signed by (64 lowercase hex), the owner of this gesture. */
  readonly ownerNostr: string;
  readonly removeFolder: (name: string) => Promise<void>;
  readonly erase: KeyEraseControl;
  readonly owner: LocalUiOwnerOperation;
  readonly now: () => number;
}

/**
 * Try again after a stop between step 6 and step 7 (IR-U3-e-SEC-1 GAP B): the agent's keys are gone,
 * so its store no longer opens, but it is retired (a verifying entry in the revoked list) and marked.
 * The gesture signs a fresh `agent.revoke` for the same agent (D-68: every presence route signs; it
 * is idempotent and not stored, the recorded entry stays), then the erase runs again (idempotent)
 * and the folder goes. Nothing is sent: the contacts were told, or the owner chose Remove anyway,
 * before the keys went.
 */
export async function runFinishSteps(steps: FinishSteps): Promise<'removed'> {
  const { body } = buildAgentRevokeBody({
    agent: steps.agentId,
    owner: steps.ownerNostr,
    issuedAt: steps.now(),
  });
  const signatures = await steps.owner.sign(
    // The store no longer opens, so no verified label can be read: the folder name only.
    { lines: removeStatement(steps.name, steps.name, 0) },
    [{ kind: 'owner-action', action: body as unknown as JsonObject }],
  );
  const first = signatures[0];
  if (signatures.length !== 1 || first?.kind !== 'owner-action') {
    throw new RemovalStepFailed('sign');
  }
  const signedText = canonicalize(first.signed as unknown as JsonValue);
  if (!verifyRevokedEntry(signedText, steps.agentId, `0x${steps.ownerNostr}`).ok) {
    throw new RemovalStepFailed('sign');
  }
  await step('keys', () =>
    steps.erase.eraseAgentKeys({ agentId: steps.agentId, storageIds: [], revoke: steps.recorded }),
  );
  await step('folder', () => steps.removeFolder(steps.name));
  return 'removed';
}
