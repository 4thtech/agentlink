// M1-36b-2 (D-121 D6; 04 §2.5, §2.8; 06 §3): `owner init` and `owner add-agent` sign the agent's
// first `policy.set`, the 06 §3 defaults with only `files.allowedFolders` = the empty
// `~/AgentLink/Send` folder (its real path), in the same owner-code entry as the first card.
//
// - One entry: the owner code is typed once for the card and the first rules.
// - Defaults unchanged apart from the Send folder; node refuses to sign anything wider, whatever core
//   prepared (policy widening).
// - A failure leaves no half-set state: no policy, the folder this run created removed, the card and
//   owner as they were before this feature.
// - The folder is new and empty or already empty, a real folder (no link), so no existing file
//   becomes sendable.
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  POLICY_DEFAULTS_EFFECTIVE,
  type ApprovalChannel,
  type OwnerActionOutcome,
  type PreparedPolicyEdit,
} from '@4thtech-io/core';
import {
  canonicalize,
  encodeUtf8,
  type JsonObject,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { addAgentWith } from './owner-add-agent.js';
import type { FirstAgentCard, FirstPolicyActions } from './owner-first-card.js';
import { initOwnerWith } from './owner-init.js';
import { OWNER_ACCOUNT } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface Agent {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
}

let dir: string;
let home: string;
let keychain: MapKeychain;
let now: number;
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-first-policy-'));
  home = join(dir, 'home');
  await mkdir(home);
  keychain = new MapKeychain();
  now = Math.floor(Date.now() / 1000);
});
afterEach(async () => {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

async function initAgent(label: string): Promise<Agent> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, `${label}.sqlite`), {
    keychain,
  });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => now,
    policyMark: store.policyMark,
  });
  const agent = { agentId, client, store, keyStore };
  opened.push(agent);
  return agent;
}

/** The card with the first rules; `actions` defaults to the agent's own core OwnerActions. */
const withPolicy = (
  agent: Agent,
  name: string,
  actions: FirstPolicyActions = agent.client.ownerActions,
): FirstAgentCard => ({
  agent: agent.agentId,
  name,
  relays: RELAYS,
  identity: agent.client.identity,
  firstPolicy: { actions, home },
});

const cardOnly = (agent: Agent, name: string): FirstAgentCard => ({
  agent: agent.agentId,
  name,
  relays: RELAYS,
  identity: agent.client.identity,
});

/** The owner at `owner init`: re-types the last group of the code it was shown. */
function ownerAtInit(retype?: string) {
  const written: string[] = [];
  const labels: string[] = [];
  const shown = (): string =>
    (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      return Promise.resolve(encodeUtf8(retype ?? shown().slice(-4)));
    },
    confirm: () => Promise.resolve(false),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels, shown };
}

/** The owner at `owner add-agent`: types `entries` in turn; answers `confirm` with `yes`. */
function ownerTyping(entries: readonly string[], yes = false) {
  const written: string[] = [];
  const labels: string[] = [];
  const queue = [...entries];
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: (label) => {
      labels.push(label);
      return Promise.resolve(encodeUtf8(queue.shift() ?? ''));
    },
    confirm: () => Promise.resolve(yes),
    clearScreen: () => void written.push('<clear>'),
  };
  return { terminal, written, labels };
}

async function sendFolder(): Promise<string> {
  return join(await realpath(home), 'AgentLink', 'Send');
}

/** The 06 §3 defaults with only `files.allowedFolders` replaced. */
function defaultsWith(folders: readonly string[]): string {
  const base = JSON.parse(JSON.stringify(POLICY_DEFAULTS_EFFECTIVE.policy)) as {
    files: Record<string, unknown>;
  };
  return canonicalize({ ...base, files: { ...base.files, allowedFolders: [...folders] } });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function ownerInitFor(
  agent: Agent,
  card: FirstAgentCard,
): Promise<{ owner: OwnerPublicKeys; code: string; run: ReturnType<typeof ownerAtInit> }> {
  const run = ownerAtInit();
  const result = await initOwnerWith(
    keychain,
    run.terminal,
    { backend: 'keychain', env: {}, firstCard: card },
    { kdf: KDF },
  );
  return { owner: result.owner, code: run.shown().replace(/ /g, ''), run };
}

/** OwnerActions double over the real one: counts applies and can alter what is prepared. */
function spyActions(
  agent: Agent,
  options: {
    alter?: (prepared: PreparedPolicyEdit) => PreparedPolicyEdit;
    apply?: (input: object) => Promise<OwnerActionOutcome>;
  } = {},
) {
  const applied: object[] = [];
  const prepared: unknown[] = [];
  const actions: FirstPolicyActions = {
    preparePolicyEdit: async (patch, opts) => {
      prepared.push(patch);
      const real = await agent.client.ownerActions.preparePolicyEdit(patch, opts);
      return options.alter === undefined ? real : options.alter(real);
    },
    apply: (input) => {
      applied.push(input);
      return options.apply === undefined
        ? agent.client.ownerActions.apply(input)
        : options.apply(input);
    },
  };
  return { actions, applied, prepared };
}

function alterPolicy(
  prepared: PreparedPolicyEdit,
  change: (body: JsonObject) => void,
): PreparedPolicyEdit {
  if (prepared.status !== 'prepared') return prepared;
  const body = JSON.parse(JSON.stringify(prepared.body)) as JsonObject;
  change(body);
  return { ...prepared, body: body as unknown as typeof prepared.body, jcs: canonicalize(body) };
}

describe('owner init signs the first rules with the first card (M1-36b-2; 04 §2.5; D-121 D6)', () => {
  it('one code entry: the card and the defaults plus the empty Send folder', async () => {
    const alice = await initAgent('alice');
    const { run } = await ownerInitFor(alice, withPolicy(alice, 'alice'));
    expect(run.labels).toHaveLength(1);

    const effective = await alice.client.ownerActions.loadPolicy();
    expect(effective.mode).toBe('signed');
    if (effective.mode !== 'signed') return;
    expect(effective.version).toBe(1);
    const folder = await sendFolder();
    // Defaults unchanged apart from the Send folder.
    expect(canonicalize(effective.policy)).toBe(defaultsWith([folder]));

    // A real, empty folder, readable only by this user.
    const stats = await lstat(folder);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(await readdir(folder)).toEqual([]);
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o700);
    expect(await realpath(folder)).toBe(folder);
  });

  it('tells the owner about the Send folder before the owner code is shown, and after', async () => {
    const alice = await initAgent('alice');
    const { run } = await ownerInitFor(alice, withPolicy(alice, 'alice'));
    const folder = await sendFolder();
    const review = run.written.findIndex((t) => t.includes(folder) && t.includes('Send'));
    const code = run.written.findIndex((t) => t.startsWith('Your owner code: '));
    expect(review).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(code);
    expect(run.written.join('\n')).toContain('agentlink policy remove-folder');
    // No wallet words in the copy (11 §5).
    expect(run.written.join('\n')).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('reports the folder in the result', async () => {
    const alice = await initAgent('alice');
    const run = ownerAtInit();
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice') },
      { kdf: KDF },
    );
    expect(result.sendFolder).toEqual({ status: 'allowed', folder: await sendFolder() });
  });

  it('without firstPolicy nothing changes: no folder, the defaults', async () => {
    const alice = await initAgent('alice');
    await ownerInitFor(alice, cardOnly(alice, 'alice'));
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('a Send folder that already holds files is not allowed and nothing in it is touched', async () => {
    const alice = await initAgent('alice');
    await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send', 'private.txt'), 'x');
    const run = ownerAtInit();
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice') },
      { kdf: KDF },
    );
    expect(result.card).toBeDefined();
    expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'folder_not_empty' });
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await readdir(join(home, 'AgentLink', 'Send'))).toEqual(['private.txt']);
  });

  it('an already empty Send folder is allowed and kept', async () => {
    const alice = await initAgent('alice');
    await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
    await ownerInitFor(alice, withPolicy(alice, 'alice'));
    const effective = await alice.client.ownerActions.loadPolicy();
    expect(canonicalize(effective.policy)).toBe(defaultsWith([await sendFolder()]));
  });

  it.skipIf(process.platform === 'win32')(
    'a Send folder that is a link is not allowed (no existing folder becomes sendable)',
    async () => {
      const alice = await initAgent('alice');
      const elsewhere = join(dir, 'elsewhere');
      await mkdir(elsewhere);
      await mkdir(join(home, 'AgentLink'));
      await symlink(elsewhere, join(home, 'AgentLink', 'Send'));
      const run = ownerAtInit();
      const result = await initOwnerWith(
        keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice') },
        { kdf: KDF },
      );
      expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'folder_unavailable' });
      expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'an AgentLink folder that is a link is not allowed',
    async () => {
      const alice = await initAgent('alice');
      const elsewhere = join(dir, 'elsewhere');
      await mkdir(join(elsewhere, 'Send'), { recursive: true });
      await symlink(elsewhere, join(home, 'AgentLink'));
      const run = ownerAtInit();
      const result = await initOwnerWith(
        keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice') },
        { kdf: KDF },
      );
      expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'folder_unavailable' });
      expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    },
  );

  it('a code that is not confirmed creates nothing and leaves no folder behind', async () => {
    const alice = await initAgent('alice');
    const run = ownerAtInit('ZZZZ');
    await expect(
      initOwnerWith(
        keychain,
        run.terminal,
        { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice') },
        { kdf: KDF },
      ),
    ).rejects.toMatchObject({ code: 'owner_secret_refused' });
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('a card that is not signed signs no rules and removes the folder (no half-set state)', async () => {
    const alice = await initAgent('alice');
    const spy = spyActions(alice);
    const card: FirstAgentCard = {
      ...withPolicy(alice, 'alice', spy.actions),
      identity: {
        get: () => alice.client.identity.get(),
        init: () => Promise.reject(new Error('core refused')),
      },
    };
    const run = ownerAtInit();
    await expect(
      initOwnerWith(keychain, run.terminal, { backend: 'keychain', env: {}, firstCard: card }, {
        kdf: KDF,
      }),
    ).rejects.toMatchObject({ code: 'owner_card_failed' });
    expect(spy.applied).toEqual([]);
    expect(spy.prepared).toEqual([]);
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('rules that are refused leave the defaults, keep the card and remove the folder', async () => {
    const alice = await initAgent('alice');
    const spy = spyActions(alice, {
      apply: () =>
        Promise.resolve({
          status: 'refused',
          op: 'policy.set',
          reason: 'store_changed',
          nonceBurnt: false,
        } as unknown as OwnerActionOutcome),
    });
    const run = ownerAtInit();
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice', spy.actions) },
      { kdf: KDF },
    );
    expect(spy.applied).toHaveLength(1);
    expect(result.card).toBeDefined();
    expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'failed' });
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
    expect(keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(run.written.join('\n')).toContain('agentlink policy allow-folder');
  });

  it('rules applied but not confirmed point the owner to policy recover', async () => {
    const alice = await initAgent('alice');
    const spy = spyActions(alice, {
      apply: () =>
        Promise.resolve({
          status: 'applied',
          op: 'policy.set',
          policyVersion: 1,
          markRaised: false,
        } as OwnerActionOutcome),
    });
    const run = ownerAtInit();
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice', spy.actions) },
      { kdf: KDF },
    );
    expect(result.sendFolder).toEqual({ status: 'not_confirmed', folder: await sendFolder() });
    expect(run.written.join('\n')).toContain('agentlink policy recover');
  });

  it.each([
    [
      'a looser proof rule',
      (body: JsonObject) => {
        const policy = (body['params'] as JsonObject)['policy'] as JsonObject;
        (policy['proofs'] as JsonObject)['notarize'] = 'allow';
      },
    ],
    [
      'a second folder',
      (body: JsonObject) => {
        const policy = (body['params'] as JsonObject)['policy'] as JsonObject;
        const files = policy['files'] as JsonObject;
        files['allowedFolders'] = ['/', ...(files['allowedFolders'] as string[])].sort();
      },
    ],
    [
      'another agent',
      (body: JsonObject) => {
        body['agent'] = '0x' + '11'.repeat(20);
      },
    ],
    [
      'another owner',
      (body: JsonObject) => {
        body['owner'] = '22'.repeat(32);
      },
    ],
    [
      'another op',
      (body: JsonObject) => {
        body['op'] = 'contact.remove';
      },
    ],
  ])('never signs %s, whatever was prepared (policy widening)', async (_label, change) => {
    const alice = await initAgent('alice');
    const spy = spyActions(alice, { alter: (p) => alterPolicy(p, change) });
    const run = ownerAtInit();
    const result = await initOwnerWith(
      keychain,
      run.terminal,
      { backend: 'keychain', env: {}, firstCard: withPolicy(alice, 'alice', spy.actions) },
      { kdf: KDF },
    );
    expect(spy.applied).toEqual([]);
    expect(result.card).toBeDefined();
    expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'failed' });
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('the signed rules cannot be replayed (the nonce is used)', async () => {
    const alice = await initAgent('alice');
    const spy = spyActions(alice);
    await ownerInitFor(alice, withPolicy(alice, 'alice', spy.actions));
    expect(spy.applied).toHaveLength(1);
    const again = await alice.client.ownerActions.apply(spy.applied[0] as object);
    expect(again.status).toBe('refused');
  });
});

describe('owner add-agent signs the first rules with the card (M1-36b-2; 04 §2.8)', () => {
  it('one code entry: the card and the defaults plus the Send folder for this agent only', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInitFor(alice, cardOnly(alice, 'alice'));
    const run = ownerTyping([code]);
    const result = await addAgentWith(keychain, run.terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: withPolicy(bob, 'bob'),
    });
    expect(run.labels).toEqual(['Owner code:']);
    expect(result.sendFolder).toEqual({ status: 'allowed', folder: await sendFolder() });
    const effective = await bob.client.ownerActions.loadPolicy();
    expect(effective.mode).toBe('signed');
    expect(canonicalize(effective.policy)).toBe(defaultsWith([await sendFolder()]));
    // Alice's rules are her own (the action binds to Bob by `agent`).
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    // Shown before the prompt.
    expect(run.written.join('\n')).toContain(await sendFolder());
  });

  it('a second agent shares the empty Send folder that the first one allowed', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInitFor(alice, withPolicy(alice, 'alice'));
    await addAgentWith(keychain, ownerTyping([code]).terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: withPolicy(bob, 'bob'),
    });
    const effective = await bob.client.ownerActions.loadPolicy();
    expect(canonicalize(effective.policy)).toBe(defaultsWith([await sendFolder()]));
  });

  it('M1-9x path (no local card names the owner): one entry, card and rules', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { code } = await ownerInitFor(alice, cardOnly(alice, 'alice'));
    const run = ownerTyping([code], true);
    const result = await addAgentWith(keychain, run.terminal, {
      backend: 'keychain',
      env: {},
      card: withPolicy(bob, 'bob'),
    });
    expect(run.labels).toHaveLength(1);
    expect(result.sendFolder).toEqual({ status: 'allowed', folder: await sendFolder() });
    expect((await bob.client.ownerActions.loadPolicy()).mode).toBe('signed');
  });

  it('three wrong codes write nothing and leave no folder behind', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner } = await ownerInitFor(alice, cardOnly(alice, 'alice'));
    const spy = spyActions(bob);
    await expect(
      addAgentWith(keychain, ownerTyping(['A', 'B', 'C']).terminal, {
        backend: 'keychain',
        env: {},
        owner,
        card: withPolicy(bob, 'bob', spy.actions),
      }),
    ).rejects.toMatchObject({ code: 'owner_secret_refused' });
    expect(spy.applied).toEqual([]);
    expect(await bob.client.identity.get()).toBeUndefined();
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('refused rules keep the card, the defaults, and remove the folder', async () => {
    const alice = await initAgent('alice');
    const bob = await initAgent('bob');
    const { owner, code } = await ownerInitFor(alice, cardOnly(alice, 'alice'));
    const spy = spyActions(bob, {
      alter: (p) =>
        alterPolicy(p, (body) => {
          body['agent'] = alice.agentId;
        }),
    });
    const result = await addAgentWith(keychain, ownerTyping([code]).terminal, {
      backend: 'keychain',
      env: {},
      owner,
      card: withPolicy(bob, 'bob', spy.actions),
    });
    expect(spy.applied).toEqual([]);
    expect(result.card).toBeDefined();
    expect(result.sendFolder).toEqual({ status: 'not_allowed', reason: 'failed' });
    expect((await bob.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect((await alice.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });
});
