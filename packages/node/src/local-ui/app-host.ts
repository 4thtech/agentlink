// U3-c: the app host (08 §1 "Agents and AI apps in the app"; 04 §2.5 "Several agents in one app";
// 06 §6; 07 §9.1; D-138; I-1, I-2, I-4, I-7).
//
// One app, one agent open at a time. The `ui` process is the app host: it lists the agents, opens the
// current one through the same `openAgent` path as every other process (the CLI passes `open`), and on
// a switch closes it and opens the other in the same process, port and session: no new link, no new
// token. The server reaches agent folders only through the `AgentDirectory` seam the CLI passes in
// (apps/cli/src/runtime/agent-dir.ts), so the folder and name rules (06 §6, 07 §9.1) stay in one
// place; this package never builds an agent path.
//
// Generation (08 §1). Each switch increases a number held here. Every answer of the server carries it
// (and the open agent's label); every mutating request carries the generation the page was built
// against and is refused with `agent_changed` when it differs, when it arrives (before any presence
// check) and again right before the server acts (`Hold.valid`). A switch first raises the number (so
// every request still on its way is refused at its next check), then waits for the requests in
// flight to finish, then closes the agent and opens the other. The generation is a page guard only:
// it is never part of a signed object; what binds an owner action to an agent is `agent` in the
// signed object, which core verifies (04 §2.5.1).
//
// KeyStore isolation (04 §2.5). At most one agent's KeyStore and store are open here: the old agent's
// `close` (the CLI's openAgent close: relay connections, store, KeyStore, and its shared folder lock)
// settles before the other is opened. Nothing of one agent (keys, OwnerSession, approvals, nonces,
// pending setup or confirmations) is carried to the other: the server rebinds every per-agent piece
// (approval-server.ts `bindAgent`). A switch signs nothing, takes no owner presence and holds no owner
// secret: it only changes which agent the page shows. An agent marked `removing` (or in the owner's
// revoked list, which the directory reports as `removing`) is never opened.
//
// Platform note (U3-c residual, 04 §2.5 "Residuals"): switching opens the other agent's keychain items
// without a gesture. macOS: the first read of an agent's items by this program may show the system
// keychain prompt ("allow AgentLink to use ..."); "Always Allow" stops it for that item. Windows
// Credential Manager and Linux Secret Service (an unlocked login keyring) show no prompt per item. A
// file-KeyStore agent (04 §2.8) needs its unlock passphrase from the environment, as for every other
// process; without it the open fails and the switch answers `unavailable` (the previous agent is
// opened again). This adds no exposure: every agent of the OS user can already read the others'
// items (04 §2.8 "Logical isolation", G-1).
import type { ApprovalServerSource } from '../approval-server.js';
import type { LocalUiOptions } from './context.js';
import type { AgentRemovalPort } from './api/agents-remove.js';
import type { FirstAgentCard } from '../owner-first-card.js';

/** One agent folder as the directory reports it. Never a path. */
export interface AgentDirectoryEntry {
  /** The folder name (06 §6 agent-name rule; checked by the directory). */
  readonly name: string;
  /** The label from config.json (display only, 07 §9.1), else the name. Plain text. */
  readonly label: string;
  /** config.json holds a label (written only after a verified `agent.label`). */
  readonly labelled?: boolean;
  /** False when the folder's config cannot be read (the agent is listed, never opened). */
  readonly available: boolean;
  /** `removing: true` in config.json, or the agent's ID is in the owner's revoked list. */
  readonly removing: boolean;
}

/** What the Agents list shows of an agent's store (clear columns only, node agent-peek.ts). */
export interface AgentDirectoryStats {
  readonly contacts: number;
  readonly running: boolean;
}

/**
 * The agent folders, implemented by the CLI over agent-dir.ts (the one place of the folder rules).
 * Every method checks the name itself; errors are fixed codes, never a path (I-7).
 */
export interface AgentDirectory {
  /** Every agent folder with a valid name, sorted by name; none is skipped for a bad config. */
  list(): Promise<readonly AgentDirectoryEntry[]>;
  /** One agent, or undefined when there is no folder of that name. */
  read(name: string): Promise<AgentDirectoryEntry | undefined>;
  /** The contact count and Running of one agent; undefined when its store cannot be read now. */
  stats(name: string): Promise<AgentDirectoryStats | undefined>;
  /** Card U3-d: writes the verified label into config.json (07 §9.1). */
  writeLabel(name: string, label: string): Promise<void>;
  /**
   * Card U3-d: creates a keychain agent in a new folder whose name is a slug of `label` (06 §6), made
   * unique with a suffix; config.json holds no label yet (it is written only after the signed
   * `agent.label` was verified). Returns the folder name.
   */
  create?(label: string): Promise<string>;
  /**
   * Card U3-d: removes an agent that `create` made and that was not completed (all or nothing): its
   * keychain items and its folder. Only ever called for an agent this process just created.
   */
  discardNew?(name: string): Promise<void>;
  /** Card U3-e: writes `removing: true` into config.json before anything is deleted. */
  markRemoving(name: string): Promise<void>;
  /** Card U3-e: deletes the agent folder's known files and the folder (no recursive delete). */
  removeFolder(name: string): Promise<void>;
  /** The last used agent from `~/.agentlink/app.json`; undefined when absent or not valid. */
  readCurrent(): Promise<string | undefined>;
  /** Writes `{v:1, current}` to `~/.agentlink/app.json` (0600). Trusted for nothing but order. */
  writeCurrent(name: string): Promise<void>;
}

/** One opened agent as the host serves it (the CLI's openAgent result, wired for the pages). */
export interface AppHostAgent {
  readonly name: string;
  /** Its label (display only, 07 §9.1), else the name. Shown as plain text, never trusted. */
  readonly label: string;
  readonly source: ApprovalServerSource;
  /** The per-agent local UI options; `assets` are the server's and never change on a switch. */
  readonly localUi: Omit<LocalUiOptions, 'assets'>;
  /**
   * U3-d: the agent's own card parts with its core actions (the CLI wiring), for the first card of
   * an agent created from the app. Absent: this agent cannot be given its first parts here.
   */
  readonly firstCard?: FirstAgentCard;
  /** Closes the agent: relay connections, store, KeyStore and its shared folder lock. Idempotent. */
  close(): Promise<void>;
}

/** `ApprovalServerOptions.host`: present only in the `ui` process (the app host). */
export interface AppHostOptions {
  readonly directory: AgentDirectory;
  /** The agent opened first (by the CLI, before the server starts). The host owns it from here. */
  readonly initial: AppHostAgent;
  /** Opens an agent through the CLI's openAgent path; undefined when it cannot be opened. */
  open(name: string): Promise<AppHostAgent | undefined>;
  /** U3-e: removing an agent (agents-remove.ts); absent: the remove route answers `not_available`. */
  readonly removal?: AgentRemovalPort;
}

/** A request's place in the host: `valid` re-checks the generation, `leave` ends it. */
export interface AppHostHold {
  valid(): boolean;
  leave(): void;
}

export type AppHostSwitchOutcome =
  'done' | 'agent_changed' | 'busy' | 'unknown_agent' | 'removing' | 'unavailable';

/** How long a switch waits for the requests in flight before it closes the agent anyway. */
export const SWITCH_DRAIN_MS = 10_000;

/** The 06 §6 agent-name rule, checked again here before the directory sees the name. */
export const HOST_AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The generation as it travels in a header or a body: a decimal integer, 1 or more. */
const GENERATION_TEXT = /^[1-9][0-9]{0,15}$/;

/**
 * The host's state: the open agent, the generation and the requests in flight. The server calls
 * `bind` with each newly opened agent (or undefined when none could be opened).
 */
export class AppHostSlot {
  readonly #options: AppHostOptions;
  readonly #bind: (agent: AppHostAgent | undefined) => void;
  readonly #drainMs: number;
  #agent: AppHostAgent | undefined;
  #generation = 1;
  #inflight = 0;
  #idle: (() => void)[] = [];
  #switching: Promise<void> | undefined;
  #closed = false;

  constructor(
    options: AppHostOptions,
    bind: (agent: AppHostAgent | undefined) => void,
    drainMs: number = SWITCH_DRAIN_MS,
  ) {
    this.#options = options;
    this.#bind = bind;
    this.#drainMs = drainMs;
    this.#agent = options.initial;
    bind(options.initial);
  }

  get generation(): number {
    return this.#generation;
  }

  /** The open agent's name, or undefined when none is open. */
  get current(): string | undefined {
    return this.#agent?.name;
  }

  /**
   * U3-d: opens an agent this host just created, for its first parts only, without switching to it
   * (the open agent and the generation stay). The caller closes it. Undefined when it cannot open.
   */
  openNew(name: string): Promise<AppHostAgent | undefined> {
    if (!HOST_AGENT_NAME.test(name) || name === this.#agent?.name) {
      return Promise.resolve(undefined);
    }
    return this.#options.open(name).catch(() => undefined);
  }

  get directory(): AgentDirectory {
    return this.#options.directory;
  }

  /** True when `text` is exactly the current generation (a header or body value). */
  matches(text: unknown): boolean {
    return (
      typeof text === 'string' && GENERATION_TEXT.test(text) && text === String(this.#generation)
    );
  }

  #hold(generation: number): AppHostHold {
    this.#inflight += 1;
    let left = false;
    return Object.freeze<AppHostHold>({
      valid: () => !left && this.#generation === generation,
      leave: () => {
        if (left) return;
        left = true;
        this.#inflight -= 1;
        // Each waiter re-checks its own bound (#drainedBut) and waits again if it is not met.
        for (const done of this.#idle.splice(0)) done();
      },
    });
  }

  /** A read: waits while a switch is in progress, then holds the agent open until `leave`. */
  async enter(): Promise<AppHostHold> {
    while (this.#switching !== undefined) await this.#switching;
    return this.#hold(this.#generation);
  }

  /**
   * A mutating request: refused (undefined, answered `agent_changed`) when `generation` is not the
   * current one or a switch is in progress; otherwise held until `leave`.
   */
  enterMutating(generation: unknown): AppHostHold | undefined {
    if (this.#switching !== undefined || !this.matches(generation)) return undefined;
    return this.#hold(this.#generation);
  }

  #drained(): Promise<void> {
    return this.#drainedBut(0);
  }

  /** `POST /api/ui/agents/switch {name, generation}` (approval-server.ts switchGate). */
  async switchTo(name: unknown, generation: unknown): Promise<AppHostSwitchOutcome> {
    if (this.#closed) return 'unavailable';
    if (this.#switching !== undefined) return 'busy';
    if (!this.matches(generation)) return 'agent_changed';
    if (typeof name !== 'string' || !HOST_AGENT_NAME.test(name)) return 'unknown_agent';
    // Claimed at once, before anything awaits: a second switch is busy, a new request waits or is
    // refused, and nothing reaches the agent until this switch is settled.
    let finish: () => void = () => undefined;
    this.#switching = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await this.#switchClaimed(name);
    } finally {
      this.#switching = undefined;
      finish();
    }
  }

  async #switchClaimed(name: string): Promise<AppHostSwitchOutcome> {
    let entry: AgentDirectoryEntry | undefined;
    try {
      entry = await this.#options.directory.read(name);
    } catch {
      return 'unavailable';
    }
    if (entry === undefined || entry.name !== name || !entry.available) return 'unknown_agent';
    if (entry.removing) return 'removing';
    if (name === this.#agent?.name) {
      await this.#options.directory.writeCurrent(name).catch(() => undefined);
      return 'done';
    }
    // Raised first: every request still on its way is refused at its next check.
    this.#generation += 1;
    await this.#drained();
    const previous = this.#agent;
    this.#agent = undefined;
    this.#bind(undefined);
    // KeyStore isolation (04 §2.5): the old agent is closed before the other is opened.
    await previous?.close().catch(() => undefined);
    const opened = await this.#options.open(name).catch(() => undefined);
    if (opened !== undefined && opened.name === name) {
      this.#agent = opened;
      this.#bind(opened);
      await this.#options.directory.writeCurrent(name).catch(() => undefined);
      return 'done';
    }
    await opened?.close().catch(() => undefined);
    // The other agent could not be opened: the previous one is opened again, if it can be.
    if (previous !== undefined) {
      const back = await this.#options.open(previous.name).catch(() => undefined);
      if (back !== undefined && back.name === previous.name) {
        this.#agent = back;
        this.#bind(back);
      } else {
        await back?.close().catch(() => undefined);
      }
    }
    return 'unavailable';
  }

  /**
   * U3-e (04 §2.5 "Removing an agent" step 1): closes the open agent when it is `name`, so that this
   * process no longer holds its shared folder lock and the removal can take it exclusive. The
   * generation does not change: the page still shows that agent, and a refused removal opens it
   * again (`restore`) in its place. Waits for the other requests in flight (not the removal's own
   * `hold`); new ones wait or are refused while it closes. False when `name` was not open.
   */
  async closeForRemoval(
    name: string,
  ): Promise<{ readonly closed: boolean; restore(): Promise<void> }> {
    const none = { closed: false, restore: () => Promise.resolve() };
    if (this.#closed || this.#agent?.name !== name) return none;
    while (this.#switching !== undefined) await this.#switching;
    if (this.#agent?.name !== name) return none;
    let finish: () => void = () => undefined;
    this.#switching = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await this.#drainedBut(1);
      const agent = this.#agent;
      this.#agent = undefined;
      this.#bind(undefined);
      await agent?.close().catch(() => undefined);
    } finally {
      this.#switching = undefined;
      finish();
    }
    return {
      closed: true,
      restore: async () => {
        // Only into an empty host (a switch in between opened another agent: it stays).
        if (this.#closed || this.#agent !== undefined) return;
        const back = await this.#options.open(name).catch(() => undefined);
        if (back === undefined || back.name !== name || this.#agent !== undefined) {
          await back?.close().catch(() => undefined);
          return;
        }
        this.#agent = back;
        this.#bind(back);
      },
    };
  }

  /**
   * U3-e (04 §2.5 step 7): after a removal, opens another agent when none is open: the last used
   * one, else the first listed that is not `removing`; a new generation, so every page reloads for
   * it. With none left the host stays empty and the page shows "Add an agent". The owner stays.
   * `wasOpen`: the removed agent was the one open (the page must reload even when none opens).
   */
  async openAfterRemoval(wasOpen: boolean): Promise<void> {
    if (this.#closed || this.#agent !== undefined || this.#switching !== undefined) return;
    if (wasOpen) this.#generation += 1;
    let entries: readonly AgentDirectoryEntry[];
    try {
      entries = await this.#options.directory.list();
    } catch {
      return;
    }
    const usable = entries.filter((e) => e.available && !e.removing);
    const last = await this.#options.directory.readCurrent().catch(() => undefined);
    const order = [
      ...usable.filter((e) => e.name === last),
      ...usable.filter((e) => e.name !== last),
    ];
    for (const entry of order) {
      if (this.#agent !== undefined) return;
      const opened = await this.#options.open(entry.name).catch(() => undefined);
      if (opened === undefined || opened.name !== entry.name) {
        await opened?.close().catch(() => undefined);
        continue;
      }
      if (this.#agent !== undefined) {
        await opened.close().catch(() => undefined);
        return;
      }
      if (!wasOpen) this.#generation += 1;
      this.#agent = opened;
      this.#bind(opened);
      await this.#options.directory.writeCurrent(entry.name).catch(() => undefined);
      return;
    }
  }

  /** Resolves when at most `keep` requests are in flight (the caller's own), or after the drain. */
  #drainedBut(keep: number): Promise<void> {
    if (this.#inflight <= keep) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.#drainMs);
      const check = (): void => {
        if (this.#inflight <= keep) {
          clearTimeout(timer);
          resolve();
        } else {
          this.#idle.push(check);
        }
      };
      this.#idle.push(check);
    });
  }

  /** Closes the open agent (server close). */
  async close(): Promise<void> {
    this.#closed = true;
    while (this.#switching !== undefined) await this.#switching;
    const agent = this.#agent;
    this.#agent = undefined;
    this.#bind(undefined);
    await agent?.close().catch(() => undefined);
  }
}
