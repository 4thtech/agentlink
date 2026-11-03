// ROBUSTNESS R3 (soak): the machinery of 06-soak.test.ts. Nothing here reaches a production service:
// each computer is a temp HOME (app-world.ts), the relay and the drop are in memory, the passkey is a
// virtual authenticator. No test value is printed; the canary scan reads values from the keychain
// stand-in and never prints them.
//
// Parts:
//   - a seeded RNG and a virtual clock (the host's `now`, in seconds; ~2 h are compressed into a run);
//   - KNOWN_FAILING: the one documented list of invariants that fail today because a fix is still on
//     another branch. Each entry is keyed by finding ID and is removed when its fix lands;
//   - a soak world: journey world whose relay can be switched off and whose drop can answer 5xx;
//   - a run with seams (clock, no wall-clock cap, removal fault point) and the invariant checks.
import { readFileSync, existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Page, Response as PwResponse } from 'playwright';
import { createFakeDrop } from '../../src/fake-drop.mjs';
import { memoryRelays } from '../../src/memory-relay.mjs';
import { scanForCanaries, spellings } from '../../src/canary-scan.mjs';
import {
  createClientWithoutStub,
  type UiDepsSeams,
  newComputer,
  openedLink,
  runUi,
  type Computer,
} from '../app-world.js';
import type { FakeDrop, JourneyComputer } from './world.js';

// ---------------------------------------------------------------------------------------- RNG, clock

/** mulberry32: small, seeded, repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The host clock in seconds; `advance` moves it without waiting. */
export interface VirtualClock {
  now(): number;
  advance(seconds: number): void;
  readonly elapsed: number;
}

export function virtualClock(): VirtualClock {
  let offset = 0;
  return {
    now: () => Math.floor(Date.now() / 1000) + offset,
    advance: (s) => {
      offset += s;
    },
    get elapsed() {
      return offset;
    },
  };
}

// --------------------------------------------------------------------------------------- KNOWN_FAILING

/**
 * Invariants that fail on this branch because the fix is on another branch. A hit means: the
 * assertion was skipped for this one occurrence and counted. When a finding's fix lands, delete its
 * entry here; the soak then enforces it. Keyed by finding ID (docs: robustness-plan.md).
 */
export const KNOWN_FAILING: Record<string, { what: string; hits: number }> = {
  F4: {
    what: 'create an ID after the last one was removed in a running host (agent host has no create path for zero IDs)',
    hits: 0,
  },
  F23: {
    what: 'rename/fan-out treats an empty or partly failed recipient set as failure',
    hits: 0,
  },
  'NEW-INVITE-STUCK': {
    what: 'NEW (no finding ID yet): after an ID was renamed, an invite that B accepted stays at "Connecting to ..." on both sides (repro: JOURNEY_SOAK_SEED=100 JOURNEY_SOAK_ACTIONS=rename,invite,rename,invite; or JOURNEY_SOAK_SEED=6)',
    hits: 0,
  },
  REASONS: {
    what: 'a failed /api/ui answer carries no `reason` yet (the reasons branch lands separately)',
    hits: 0,
  },
};

/** Counts one tolerated occurrence of a known finding. */
export function known(id: keyof typeof KNOWN_FAILING, note: string, log: string[]): void {
  const entry = KNOWN_FAILING[id];
  if (entry === undefined) throw new Error(`unknown finding ${String(id)}`);
  entry.hits += 1;
  log.push(`KNOWN ${String(id)}: ${note}`);
}

/**
 * Runs `fn`; if it throws, the occurrence is counted against finding `id` and `false` is returned.
 * The caller then recovers. Use only where the failure is the documented one.
 */
export async function tolerate(
  id: keyof typeof KNOWN_FAILING,
  note: string,
  log: string[],
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    known(
      id,
      `${note} (${String(error instanceof Error ? error.message.split('\n')[0] : error).slice(0, 120)})`,
      log,
    );
    return false;
  }
}

// ----------------------------------------------------------------------------------------- the world

export interface Switches {
  /** The relay refuses every connection while true. */
  relayDown: boolean;
  /** The drop answers 503 while true. */
  drop5xx: boolean;
}

export interface SoakWorld {
  readonly switches: Switches;
  readonly drop: FakeDrop;
  computer(): Promise<JourneyComputer>;
}

/** As journeyWorld, with a relay that can be switched off and a drop that can answer 5xx. */
export function soakWorld(okDelayMs = 150): SoakWorld {
  const base = memoryRelays({ okDelayMs });
  const switches: Switches = { relayDown: false, drop5xx: false };
  const relays = {
    ...base,
    connector: {
      open: (target: unknown, handlers: { onClose: () => void; onOpen: () => void }) => {
        if (switches.relayDown) {
          queueMicrotask(() => handlers.onClose());
          return { send: () => undefined, close: () => undefined };
        }
        return (base.connector.open as (t: unknown, h: unknown) => unknown)(target, handlers);
      },
    },
  } as unknown as ReturnType<typeof memoryRelays>;
  const drop = createFakeDrop();
  const realFetch = drop.fetch as unknown as (request: Request) => Promise<Response>;
  const dropFetch = ((request: Request): Promise<Response> =>
    switches.drop5xx
      ? Promise.resolve(new Response(null, { status: 503 }))
      : realFetch(request)) as typeof drop.fetch;
  return {
    switches,
    drop,
    computer: async () => {
      const pc = await newComputer(relays);
      const baseRuntime = pc.runtime;
      const runtime = {
        ...baseRuntime,
        createClient: (options: Parameters<typeof baseRuntime.createClient>[0]) =>
          createClientWithoutStub({
            ...options,
            ...(options.files === undefined
              ? {}
              : {
                  files: {
                    ...options.files,
                    drop: { endpoint: drop.origin, fetch: dropFetch },
                    download: drop.download,
                  },
                }),
          }),
      } as typeof baseRuntime;
      return { ...pc, runtime, drop };
    },
  };
}

// ----------------------------------------------------------------------------------------- the run

/** A fault in the removal port: the named step throws once, after the gesture and the mark. */
export interface Fault {
  armed: boolean;
}

export interface SoakRun {
  readonly link: string;
  readonly printed: string[];
  readonly errors: string[];
  /** True until the run's promise settles. */
  up(): boolean;
  /** The person quits (clean close). Resolves to the exit code. */
  stop(): Promise<number>;
}

/** Starts `agentlink ui` on `pc` with the soak seams (virtual clock, no wall cap, fault port). */
export async function startSoakRun(
  pc: Computer,
  files: Map<string, Uint8Array>,
  closers: (() => Promise<unknown>)[],
  clock: VirtualClock,
  fault: Fault,
): Promise<SoakRun> {
  const before = pc.opened.length;
  const run = runUi(pc, files, {
    seams: {
      now: clock.now,
      waitMs: 24 * 3_600_000,
      wrapRemoval: (port: Parameters<NonNullable<UiDepsSeams['wrapRemoval']>>[0]) =>
        Object.freeze({
          ...port,
          // The `apps` step of the removal (04 §2.5 step 5): a stand-in that fails once when armed.
          removeAppEntries: async (
            ...args: Parameters<NonNullable<typeof port.removeAppEntries>>
          ) => {
            if (fault.armed) {
              fault.armed = false;
              throw new Error('fault: apps step');
            }
            await port.removeAppEntries?.(...args);
          },
        }),
    },
  });
  let settled = false;
  void run.done.then(() => {
    settled = true;
  });
  let stopped = false;
  const stop = async (): Promise<number> => {
    if (!stopped) {
      stopped = true;
      run.deps.stop();
    }
    return (await run.done).code;
  };
  closers.push(async () => {
    await stop();
  });
  return {
    link: await openedLink(pc, before),
    printed: run.printed,
    errors: run.errors,
    up: () => !settled,
    stop,
  };
}

// ------------------------------------------------------------------------------------------ watching

export interface ApiError {
  readonly path: string;
  readonly code: number;
  readonly status: string | undefined;
  readonly reason: string | undefined;
  readonly parsed: boolean;
  readonly raw: string;
}

/** Collects every non-2xx answer of /api/ui/* the page saw. */
export function watchApi(page: Page): { drain(): ApiError[] } {
  const seen: ApiError[] = [];
  page.on('response', (res: PwResponse) => {
    void (async () => {
      const url = new URL(res.url());
      if (!url.pathname.startsWith('/api/ui/') || res.status() < 300) return;
      let status: string | undefined;
      let reason: string | undefined;
      let parsed = false;
      let raw = '';
      try {
        raw = (await res.text()).slice(0, 120);
        const body = JSON.parse(raw) as Record<string, unknown>;
        parsed = typeof body === 'object' && body !== null;
        // Actions answer {status}; reads answer {error} (route-types.ts): both are fixed words.
        const word = body['status'] ?? body['error'];
        status = typeof word === 'string' ? word : undefined;
        reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
      } catch {
        // not JSON
      }
      seen.push({ path: url.pathname, code: res.status(), status, reason, parsed, raw });
    })();
  });
  return { drain: () => seen.splice(0) };
}

/** The statuses an /api/ui answer may carry (fixed, snake_case words). */
export const STATUS_FORM = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * The `reason` words a failed answer may carry. The reasons branch lands separately; until then a
 * failed answer without `reason` is tolerated (KNOWN_FAILING.REASONS) and a reason that IS present
 * must be in this list (extend it together with that branch).
 */
export const KNOWN_REASONS = new Set([
  'network',
  'storage',
  'in_use',
  'rate_limited',
  'rename_limited',
  'refused',
  'cancelled',
  'expired',
  'not_found',
  'invalid',
  'unavailable',
  'sign',
  'record',
  'mark',
  'tell',
  'apps',
  'keys',
  'folder',
]);

/** Generic phrases that mean the app lost the thread of what went wrong. */
export const DENY = [
  "Setup didn't finish",
  'Something went wrong',
  "That didn't work",
  "can't be loaded right now",
  'Try again in a minute',
];

/** The deny-listed phrases the text holds (the rename-pending notice is the one honest use of one). */
export function deniedIn(body: string): string[] {
  return DENY.filter((phrase) => {
    if (!body.includes(phrase)) return false;
    if (phrase === 'Try again in a minute' && body.includes('last rename is still reaching')) {
      return false;
    }
    return true;
  });
}

// ------------------------------------------------------------------------------------- the home checks

/** Names a `--agent <name>` AI-app entry points at, from the settings files of the fake AI app. */
export function aiAppEntryAgents(home: string): string[] {
  const names: string[] = [];
  for (const file of ['.claude.json', join('.claude', 'settings.json')]) {
    const path = join(home, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/--agent["',\s]+([a-z][a-z0-9-]{0,31})/g)) {
      if (m[1] !== undefined) names.push(m[1]);
    }
  }
  return names;
}

/**
 * F16: puts AgentLink's own entry for `agent` into the fake Claude Code settings, so that removing
 * the ID has an AI-app entry to take out (removal step 5). Every other key is kept.
 */
export async function seedAiAppEntry(home: string, agent: string): Promise<void> {
  const file = join(home, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // no settings yet: start from nothing
  }
  const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
  servers['agentlink'] = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', agent],
    env: {},
  };
  config['mcpServers'] = servers;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
}

/** Every file under `dir`, relative (not following links). */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      for (const inner of await listing(join(dir, entry.name))) out.push(join(entry.name, inner));
    } else out.push(entry.name);
  }
  return out;
}

/** Canary values: every value the keychain stand-in holds, in every spelling. */
export async function keychainCanaries(pc: Computer, into: Map<string, Uint8Array>): Promise<void> {
  const file = join(pc.home, '..', 'keychain-stand-in.json');
  try {
    const items = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    for (const [account, value] of Object.entries(items)) {
      into.set(account, new Uint8Array(Buffer.from(value, 'base64url')));
    }
  } catch {
    // no keychain file yet
  }
}

export function canaryList(held: Map<string, Uint8Array>): { name: string; value: string }[] {
  let n = 0;
  return [...held.values()].flatMap((bytes) => spellings(`secret ${(n += 1)}`, bytes));
}

/** Files under the home and the shared logs folder that hold a canary. */
export async function canaryFindings(
  paths: string[],
  held: Map<string, Uint8Array>,
): Promise<string[]> {
  const { findings } = await scanForCanaries(paths, canaryList(held));
  return findings.map((f: { file: string; name: string }) => `${f.name} in ${f.file}`);
}

export { expect, listing };
