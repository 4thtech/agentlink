// NET-CLI (S2; D-158; 06 §8 `agentlink owner servers`; 04 §2.5, §2.6; 07 §4.3; I-4, I-7): the
// terminal path of a server-list change. The same plan the app's routes build (server-change-plan.ts:
// the servers tested again, core buildServerList, the leaving servers, the contact count, the
// warnings) is shown first; then "Continue?"; then owner presence at this process's own prompt; then
// the one gesture signs exactly that card through signServerChange, the app's path. Refusals come
// before anything is shown or asked. The package entry takes no store or terminal seam (fence).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, LEAVING_SERVER_SECONDS, type ApprovalChannel } from '@4thtech-io/core';
import type { KeyStore, OwnerPublicKeys } from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { DEFAULT_RELAYS, type PrecheckResult } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import * as entry from './index.js';
import { changeServersAtTerminal } from './index.js';
import { epochKeysOf } from './key-epoch.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import { type KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { signServerChange } from './owner-relay-migration.js';
import {
  changeServersWith,
  type ServerChangeRequest,
  type ServersAtTerminalInput,
} from './owner-server-change-terminal.js';
import { HARNESS_MARKERS, type OwnerTerminal } from './owner-terminal.js';
import type { ServerTestRun } from './server-change-plan.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const START = ['wss://relay.primal.net', 'wss://offchain.pub'];
const own = (n: number, tag = 'own'): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface World {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly keyStore: KeyStore;
  readonly owner: KeychainOwnerKeyStore;
  readonly ownerKeys: OwnerPublicKeys;
  readonly code: Uint8Array;
}

let dir: string;
let keychain: MapKeychain;
const T0 = 1_800_000_000;
let now = T0;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-servers-cli-'));
  keychain = new MapKeychain();
  now = T0;
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, 'agent.sqlite'), {
    keychain,
  });
  closers.push(() => store.close());
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  closers.push(() => keyStore.close());
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => now,
    policyMark: store.policyMark,
  });
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code, secretKind: 1 }, { kdf: KDF });
  const owner = await KeychainOwnerKeyStore.open(keychain, keys);
  closers.push(() => owner.close());
  const session = await owner.unlock({ kind: 'passphrase', secret: code.slice() });
  await client.identity.init({ owner: session, ownerKeys: keys, name: 'My agent', relays: START });
  await session.close();
  return { agentId, client, keyStore, owner, ownerKeys: keys, code };
}

const result = (outcome: PrecheckResult['outcome']): PrecheckResult => ({
  host: 'x.example.org',
  outcome,
  reason: outcome === 'refused' ? 'unreachable' : null,
  roundTripMs: 120,
  signInRequired: false,
  paymentRequired: false,
});

/** Every server ready, or the outcomes given for the own ones. */
const tests =
  (ownOutcomes?: readonly PrecheckResult['outcome'][]): ServerTestRun =>
  (urls, withDefaults) =>
    Promise.resolve([
      urls.map((_, i) => result(ownOutcomes?.[i] ?? 'ready')),
      withDefaults ? DEFAULT_RELAYS.map(() => result('ready')) : [],
    ]);

interface Script {
  readonly terminal: OwnerTerminal;
  readonly log: string[];
}

/** A terminal that records every step; `code` is what the owner types at the prompt. */
function script(code: Uint8Array | undefined, answer = true): Script {
  const log: string[] = [];
  return {
    log,
    terminal: {
      write: (text) => void log.push(`write:${text}`),
      confirm: (q) => {
        log.push(`confirm:${q}`);
        return Promise.resolve(answer);
      },
      readSecret: () => {
        log.push('secret');
        return Promise.resolve(code === undefined ? new Uint8Array(8) : code.slice());
      },
    },
  };
}

function input(w: World, request: ServerChangeRequest): ServersAtTerminalInput {
  const epochKeys = epochKeysOf(w.keyStore);
  if (epochKeys === undefined) throw new Error('test: no epoch keys');
  return {
    agent: w.agentId,
    client: w.client,
    epochKeys,
    ownerKeys: w.ownerKeys,
    request,
    describe: (review) => [`REVIEW ${String(review.servers.length)} ${review.kind}`],
  };
}

const run = (
  w: World,
  s: Script,
  request: ServerChangeRequest,
  test: ServerTestRun = tests(),
): ReturnType<typeof changeServersWith> =>
  changeServersWith(w.owner, s.terminal, input(w, request), { test, now: () => now });

describe('changeServersWith: review, then Continue?, then presence, then the one signature', () => {
  it('shows the reviewed plan before asking for presence, then signs exactly that list', async () => {
    const w = await world();
    const s = script(w.code);
    const outcome = await run(w, s, {
      kind: 'servers',
      servers: own(2),
      automatic: true,
      announce: true,
    });
    expect(outcome).toMatchObject({ status: 'changed', leavingUntil: T0 + LEAVING_SERVER_SECONDS });
    const review = s.log.findIndex((l) => l.startsWith('write:REVIEW 4 servers'));
    const confirm = s.log.findIndex((l) => l.startsWith('confirm:'));
    const secret = s.log.indexOf('secret');
    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(secret);
    expect(await w.client.identity.relays()).toEqual([...own(2), ...DEFAULT_RELAYS.slice(0, 2)]);
    expect((await w.client.identity.get())?.keyEpoch).toBe(1);
  });

  it('without presence (a wrong code) nothing is signed', async () => {
    const w = await world();
    const s = script(new Uint8Array(16).fill(7));
    await expect(
      run(w, s, { kind: 'servers', servers: own(3), automatic: false, announce: true }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
    expect(await w.client.identity.relays()).toEqual(START);
  });

  it('a "no" at Continue? asks for nothing and changes nothing', async () => {
    const w = await world();
    const s = script(w.code, false);
    await expect(
      run(w, s, { kind: 'servers', servers: own(3), automatic: false, announce: true }),
    ).rejects.toMatchObject({ code: 'owner_prompt_cancelled' });
    expect(s.log).not.toContain('secret');
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
  });

  it('the opt-out with the mix-in on is refused (mix_in_on) before anything is shown', async () => {
    const w = await world();
    const s = script(w.code);
    expect(
      await run(w, s, { kind: 'servers', servers: own(2), automatic: true, announce: false }),
    ).toEqual({ status: 'refused', reason: 'mix_in_on' });
    // An own list that holds a default server counts as the mix-in too.
    expect(
      await run(w, s, {
        kind: 'servers',
        servers: [own(1)[0] ?? '', DEFAULT_RELAYS[0] ?? ''],
        automatic: false,
        announce: false,
      }),
    ).toEqual({ status: 'refused', reason: 'mix_in_on' });
    expect(s.log).toEqual([]);
  });

  it('fewer than 2 own servers ready is refused (not_ready) before anything is shown', async () => {
    const w = await world();
    const s = script(w.code);
    expect(
      await run(
        w,
        s,
        { kind: 'servers', servers: own(2), automatic: true, announce: true },
        tests(['ready', 'refused']),
      ),
    ).toEqual({ status: 'refused', reason: 'not_ready' });
    expect(s.log).toEqual([]);
  });

  it('an address that breaks the URL rule is refused (invalid_list), nothing tested', async () => {
    const w = await world();
    const s = script(w.code);
    let tested = 0;
    const counting: ServerTestRun = (urls, d) => {
      tested += 1;
      return tests()(urls, d);
    };
    expect(
      await run(
        w,
        s,
        {
          kind: 'servers',
          servers: ['wss://10.0.0.1', 'wss://a.example.org'],
          automatic: false,
          announce: true,
        },
        counting,
      ),
    ).toEqual({ status: 'refused', reason: 'invalid_list' });
    expect(tested).toBe(0);
  });

  it('past 16 leaving servers: refused with the date it fits from, nothing shown or signed', async () => {
    const w = await world();
    const epochKeys = epochKeysOf(w.keyStore);
    if (epochKeys === undefined) throw new Error('test: no epoch keys');
    for (const tag of ['a', 'b']) {
      const session = await w.owner.unlock({ kind: 'passphrase', secret: w.code.slice() });
      await signServerChange(session, w.ownerKeys, {
        agent: w.agentId,
        client: w.client,
        epochKeys,
        relays: own(8, tag),
        announceDefault: true,
      });
      await session.close();
      now += 100;
    }
    const s = script(w.code);
    expect(
      await run(w, s, { kind: 'servers', servers: own(8, 'c'), automatic: false, announce: true }),
    ).toEqual({ status: 'refused', reason: 'too_many_previous', fitsAt: T0 + LEAVING_SERVER_SECONDS });
    expect(s.log).toEqual([]);
    expect((await w.client.identity.get())?.keyEpoch).toBe(2);
  });

  it('the same list is refused (same_list); a reset goes back to automatic and clears the opt-out', async () => {
    const w = await world();
    expect(
      await run(w, script(w.code), {
        kind: 'servers',
        servers: own(2),
        automatic: false,
        announce: false,
      }),
    ).toMatchObject({ status: 'changed' });
    expect(await w.client.identity.announceDefault()).toBe(false);
    now += 60;
    expect(
      await run(w, script(w.code), {
        kind: 'servers',
        servers: own(2),
        automatic: false,
        announce: false,
      }),
    ).toEqual({ status: 'refused', reason: 'same_list' });
    now += 60;
    const s = script(w.code);
    expect(await run(w, s, { kind: 'reset' })).toMatchObject({ status: 'changed' });
    expect(s.log.some((l) => l.startsWith('write:REVIEW') && l.endsWith('reset'))).toBe(true);
    expect(await w.client.identity.relays()).toEqual(DEFAULT_RELAYS);
    expect(await w.client.identity.announceDefault()).toBe(true);
    now += 60;
    expect(await run(w, script(w.code), { kind: 'reset' })).toEqual({
      status: 'refused',
      reason: 'same_list',
    });
  });
});

describe('changeServersAtTerminal takes no seams (fence, I-4)', () => {
  it('an AI-harness marker is refused before anything is read', async () => {
    const touched: string[] = [];
    const client = new Proxy(
      {},
      {
        get: (_t, p) => {
          touched.push(String(p));
          return undefined;
        },
      },
    );
    const saved = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = '1';
    try {
      await expect(
        changeServersAtTerminal({
          agent: '0x' + '11'.repeat(20),
          client,
          epochKeys: {},
          ownerKeys: {
            ownerEvm: new Uint8Array(20),
            ownerNostr: new Uint8Array(32),
            ownerEnc: new Uint8Array(32),
          },
          request: { kind: 'reset' },
          describe: () => [],
        } as unknown as Parameters<typeof changeServersAtTerminal>[0]),
      ).rejects.toMatchObject({ code: 'harness_detected' });
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'CLAUDECODE');
      else process.env['CLAUDECODE'] = saved;
    }
    expect(touched).toEqual([]);
  });

  it('without a TTY it is refused, and a store or terminal passed in is never reached', async () => {
    const touched: string[] = [];
    const terminal = {
      write: () => void touched.push('terminal.write'),
      readSecret: () => {
        touched.push('terminal.readSecret');
        return Promise.resolve(new Uint8Array(4));
      },
      confirm: () => {
        touched.push('terminal.confirm');
        return Promise.resolve(true);
      },
    };
    const saved = HARNESS_MARKERS.map((name) => [name, process.env[name]] as const);
    for (const name of HARNESS_MARKERS) Reflect.deleteProperty(process.env, name);
    try {
      await expect(
        changeServersAtTerminal({
          agent: '0x' + '11'.repeat(20),
          client: {},
          epochKeys: {},
          ownerKeys: {
            ownerEvm: new Uint8Array(20),
            ownerNostr: new Uint8Array(32),
            ownerEnc: new Uint8Array(32),
          },
          request: { kind: 'reset' },
          describe: () => [],
          terminal,
          store: { unlock: () => touched.push('store.unlock') },
        } as unknown as Parameters<typeof changeServersAtTerminal>[0]),
      ).rejects.toMatchObject({ code: 'owner_prompt_unavailable' });
    } finally {
      for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    }
    expect(touched).toEqual([]);
  });

  it('the seam variant and the planner are not package exports', () => {
    const names = Object.keys(entry);
    for (const name of ['changeServersWith', 'planServerChange', 'signServerChange']) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain('changeServersAtTerminal');
    expect(names).toContain('testOwnServers');
  });
});
