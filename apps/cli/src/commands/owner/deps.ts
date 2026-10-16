// What the owner commands (M1-9b) need from the outside world, behind one interface so tests can
// script it. Production wires @agentlink/node's owner entry points (M1-8c) and the M1-9k runtime.
//
// I-1/I-4: no member of this interface carries an owner secret. The owner code is read by
// @agentlink/node's own TTY prompt inside `initOwner`, `addAgent`, `decide` and `signOwnerAction`, never from an
// argument, an environment variable or a pipe (04 §2.5, §2.8; D-67). `ask` reads a visible answer
// (approve, deny or later; an agent number) and is never used for a secret.
import { homedir } from 'node:os';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { AgentLinkClient, Store, StoreCipher } from '@agentlink/core';
import type { JsonObject, OwnerPublicKeys } from '@agentlink/crypto';
import {
  addAgentToOwner,
  decideReviewedApprovals,
  initOwner,
  performOwnerOperation,
  type AddAgentOptions,
  type AddAgentResult,
  type AgentStore,
  type ApprovalContext,
  type KeyStoreBackendKind,
  type OwnerInitResult,
  type OwnerSetupOptions,
  type OwnerOperationItem,
  type OwnerSignature,
  type ReviewedApproval,
} from '@agentlink/node';
import {
  listAgentNames,
  nodeRuntimeDeps,
  openAgent,
  readAgentConfig,
  type RuntimeDeps,
} from '../../runtime/index.js';
import { createOutput } from '../../output.js';
import { PROVISIONAL_CARD_RELAYS } from './card-relays.js';

/** An opened agent with the store and cipher the owner commands read approval rows through. */
export interface OwnerAgent {
  readonly name: string;
  readonly client: AgentLinkClient;
  /** The agent's shared store (07 §3). Read only: decisions are applied through `client`. */
  readonly store: Store;
  /** Opens the sealed `approvals.action_json` (07 §3.1). */
  readonly cipher: StoreCipher;
  close(): Promise<void>;
}

export type OpenOwnerAgentResult =
  | { readonly status: 'ok'; readonly agent: OwnerAgent }
  | { readonly status: 'needs_setup'; readonly message: string; readonly fix?: string };

/** The signed object core verifies and applies (04 §2.5.1). */
export interface SignedObject {
  readonly body: JsonObject;
  readonly sig: string;
}

export interface OwnerCommandDeps {
  /** The local agent names set up on this machine (06 §6). */
  listAgents(): Promise<readonly string[]>;
  /** Opens a local agent; undefined means the default agent. */
  open(name: string | undefined): Promise<OpenOwnerAgentResult>;
  /** The agent's recorded KeyStore backend, or undefined when the agent is not set up. */
  backendOf(name: string | undefined): Promise<KeyStoreBackendKind | undefined>;
  /**
   * `owner init` (M1-8c): prompts at this process's own terminal. M1-8h: in the same owner operation
   * it signs the agent's first card (`options.firstCard`) and stores it through core.
   */
  initOwner(options: OwnerSetupOptions): Promise<OwnerInitResult>;
  /**
   * `owner add-agent` (M1-9t, D-78): prompts at this process's own terminal for the existing owner
   * code once and signs exactly one first card for `options.card.agent`, stored through core.
   */
  addAgent(options: AddAgentOptions): Promise<AddAgentResult>;
  /**
   * One owner operation over the reviewed items (M1-8c): shows the decisions, asks "Continue?", reads
   * the owner code once at the TTY prompt and signs one `approval.decide` or `approval.decideBatch`.
   */
  decide(context: ApprovalContext, reviewed: readonly ReviewedApproval[]): Promise<SignedObject>;
  /** One owner operation that signs one owner action (`approval.cancel`), with presence. */
  signOwnerAction(owner: OwnerPublicKeys, item: OwnerOperationItem): Promise<OwnerSignature>;
  /** Asks a visible question at the terminal and returns the typed line. Never for a secret. */
  ask(question: string): Promise<string>;
  /** Unix seconds. */
  now(): number;
  /** M1-8h: the relay list the agent's first card commits to (card-relays.ts). */
  cardRelays(): readonly string[];
}

/** Opens an agent through the M1-9k runtime, keeping the store and cipher it opened. */
async function openWithStore(
  home: string,
  name: string | undefined,
): Promise<OpenOwnerAgentResult> {
  let opened: AgentStore | undefined;
  const deps: RuntimeDeps = {
    ...nodeRuntimeDeps,
    openStore: async (backend, agentId, path) => {
      opened = await nodeRuntimeDeps.openStore(backend, agentId, path);
      return opened;
    },
  };
  const result = await openAgent({ home, deps, ...(name === undefined ? {} : { agent: name }) });
  if (result.status !== 'ok') {
    return {
      status: 'needs_setup',
      message: result.message,
      ...(result.fix === undefined ? {} : { fix: result.fix }),
    };
  }
  const store = opened;
  if (store === undefined) {
    await result.agent.close();
    throw new Error('owner command: the agent store was not opened');
  }
  return {
    status: 'ok',
    agent: Object.freeze({
      name: result.agent.name,
      client: result.agent.client,
      store: store.store,
      cipher: store.cipher,
      close: () => result.agent.close(),
    }),
  };
}

/**
 * A visible one-line question on this process's terminal. The question goes through the CLI's
 * user-output channel; the answer is one line read from stdin in cooked mode, so the terminal echoes
 * it. Never used for a secret (the owner code is read by @agentlink/node's own prompt).
 */
async function askAtTerminal(question: string): Promise<string> {
  createOutput().print(question);
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    return await rl.question('');
  } finally {
    rl.close();
  }
}

/** The production dependencies: the OS user's home, the OS keychain and this process's TTY. */
export function nodeOwnerDeps(home: string = homedir()): OwnerCommandDeps {
  return Object.freeze<OwnerCommandDeps>({
    listAgents: () => listAgentNames(home),
    open: (name) => openWithStore(home, name),
    backendOf: async (name) => {
      const found = await readAgentConfig(home, name ?? 'default');
      return found?.config.keyStore;
    },
    initOwner: (options) => initOwner(options),
    addAgent: (options) => addAgentToOwner(options),
    decide: (context, reviewed) => decideReviewedApprovals(context, reviewed),
    signOwnerAction: (owner, item) => performOwnerOperation(owner, item),
    ask: askAtTerminal,
    now: () => Math.floor(Date.now() / 1000),
    cardRelays: () => PROVISIONAL_CARD_RELAYS,
  });
}
