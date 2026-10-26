// M1-36b-2-c (D-121 D6; 04 §2.5, §2.8; 06 §3): the Send folder for an agent that already has its
// card. `owner init` and `owner add-agent` sign the first rules (M1-36b-2); an agent set up before
// that has none, so sending a file returns NO_ALLOWED_FOLDER. The owner runs one command in their
// own terminal: `~/AgentLink/Send` is created (same rules as the first rules: real path, 0700, new
// or empty, no link) and ONE `policy.set` adds only that folder to the rules in force.
//
// - The rules only gain that one folder: node signs nothing whose policy is not, byte for byte (JCS),
//   the rules in force plus the folder (delivery receipts may only turn off, D-109). Whatever core
//   prepared is checked; anything wider is not signed.
// - A non-empty folder, a link, a non-folder: nothing is asked, nothing is signed.
// - A failure leaves no half-set state: the folders this run created are removed.
// - I-4: only the package entry `setUpSendFolder` exists; the seams stay inside (fence.test.ts).
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  AgentLinkClient,
  type ApprovalChannel,
  type EffectivePolicy,
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
import type { FirstAgentCard } from './owner-first-card.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import {
  runOwnerOperation,
  type OwnerOperationItem,
  type OwnerSignature,
} from './owner-operation.js';
import { setUpSendFolder, type SendFolderSetupActions } from './owner-send-folder.js';
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
const opened: Agent[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-send-folder-'));
  home = join(dir, 'home');
  await mkdir(home);
  keychain = new MapKeychain();
});
afterEach(async () => {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
});

let stores = 0;

async function initAgent(label: string): Promise<Agent> {
  const agentId = await createKeychainAgent(keychain);
  stores += 1;
  const file = join(dir, `${label}-${String(stores)}.sqlite`);
  const store = await openAgentStoreWith('keychain', agentId, file, {
    keychain,
  });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => Math.floor(Date.now() / 1000),
    policyMark: store.policyMark,
  });
  const agent = { agentId, client, store, keyStore };
  opened.push(agent);
  return agent;
}

/** An agent set up before M1-36b-2: a card and an owner, but no first rules. */
async function existingAgent(): Promise<{ agent: Agent; owner: OwnerPublicKeys; code: string }> {
  const agent = await initAgent('alice');
  const written: string[] = [];
  const card: FirstAgentCard = {
    agent: agent.agentId,
    name: 'alice',
    relays: RELAYS,
    identity: agent.client.identity,
  };
  const shown = (): string =>
    (written.find((t) => t.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => undefined,
  };
  const result = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {}, firstCard: card },
    { kdf: KDF },
  );
  return { agent, owner: result.owner, code: shown().replace(/ /g, '') };
}

/** Stands in for performOwnerOperation: the summary is shown, the code typed once, one object signed. */
function ownerSigning(code: () => string) {
  const items: OwnerOperationItem[] = [];
  const lines: string[] = [];
  const sign = async (
    owner: OwnerPublicKeys,
    item: OwnerOperationItem,
  ): Promise<OwnerSignature> => {
    items.push(item);
    const store = await KeychainOwnerKeyStore.open(keychain, owner);
    const terminal: OwnerTerminal = {
      write: (text) => void lines.push(text),
      readSecret: () => Promise.resolve(encodeUtf8(code())),
      confirm: () => Promise.resolve(false),
      clearScreen: () => undefined,
    };
    try {
      return await runOwnerOperation(store, terminal, { lines: [item.summary] }, item);
    } finally {
      await store.close();
    }
  };
  return { sign, items, lines };
}

/** The agent's core OwnerActions, optionally altered, counting applies. */
function spyActions(
  agent: Agent,
  options: {
    alter?: (prepared: PreparedPolicyEdit) => PreparedPolicyEdit;
    load?: () => Promise<EffectivePolicy>;
    olderReceipts?: boolean;
    apply?: (
      input: Parameters<SendFolderSetupActions['apply']>[0],
    ) => Promise<Awaited<ReturnType<SendFolderSetupActions['apply']>>>;
  } = {},
) {
  const applied: unknown[] = [];
  const real = agent.client.ownerActions;
  const actions: SendFolderSetupActions = {
    loadPolicy: () => (options.load === undefined ? real.loadPolicy() : options.load()),
    receiptsOnFromOlderDefault: (rules) =>
      options.olderReceipts === undefined
        ? real.receiptsOnFromOlderDefault(rules)
        : Promise.resolve(options.olderReceipts),
    preparePolicyEdit: async (patch, opts) => {
      const prepared = await real.preparePolicyEdit(patch, opts);
      return options.alter === undefined ? prepared : options.alter(prepared);
    },
    apply: (input) => {
      applied.push(input);
      return options.apply === undefined ? real.apply(input) : options.apply(input);
    },
    recordReceiptsKept: (version) => real.recordReceiptsKept(version),
  };
  return { actions, applied };
}

type MutableJson = { [key: string]: unknown };

function alterPolicy(
  prepared: PreparedPolicyEdit,
  change: (body: MutableJson) => void,
): PreparedPolicyEdit {
  if (prepared.status !== 'prepared') return prepared;
  const body = JSON.parse(JSON.stringify(prepared.body)) as MutableJson;
  change(body);
  return {
    ...prepared,
    body: body as unknown as typeof prepared.body,
    jcs: canonicalize(body as JsonObject),
  };
}

/** A clean machine for the next case in a loop: agents closed, no owner, no AgentLink folder. */
async function reset(): Promise<void> {
  for (const agent of opened.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  keychain = new MapKeychain();
  await rm(join(home, 'AgentLink'), { recursive: true, force: true });
}

const sendFolder = async (): Promise<string> => join(await realpath(home), 'AgentLink', 'Send');

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The rules in force as JCS (a plain copy), and their version (0 for the defaults). */
async function rulesOf(agent: Agent): Promise<{ jcs: string; version: number; doc: MutableJson }> {
  const effective = await agent.client.ownerActions.loadPolicy();
  if (effective.mode === 'fail_closed') throw new Error('fail closed');
  const doc = JSON.parse(canonicalize(effective.policy as unknown as JsonObject)) as MutableJson;
  return {
    jcs: canonicalize(doc as JsonObject),
    version: effective.mode === 'signed' ? effective.version : 0,
    doc,
  };
}

/** `doc` with only `files.allowedFolders` replaced. */
function withFolders(doc: MutableJson, folders: readonly string[]): string {
  const files = doc['files'] as MutableJson;
  return canonicalize({ ...doc, files: { ...files, allowedFolders: [...folders] } } as JsonObject);
}

/** Signs one policy edit on the rules in force (to give the agent non-default rules first). */
async function signEdit(agent: Agent, owner: OwnerPublicKeys, code: string, patch: unknown) {
  const prepared = await agent.client.ownerActions.preparePolicyEdit(patch);
  if (prepared.status !== 'prepared') throw new Error(`not prepared: ${prepared.reason}`);
  const { sign } = ownerSigning(() => code);
  const signature = await sign(owner, {
    kind: 'owner-action',
    action: prepared.body as unknown as JsonObject,
    summary: 'test edit',
  });
  if (signature.kind !== 'owner-action') throw new Error('unexpected');
  const outcome = await agent.client.ownerActions.apply(signature.signed);
  if (outcome.status !== 'applied') throw new Error('not applied');
}

describe('setUpSendFolder: an existing agent gains only the Send folder (M1-36b-2-c)', () => {
  it('an agent on the defaults: one code entry, the defaults plus the empty Send folder', async () => {
    const { agent, owner, code } = await existingAgent();
    const before = await rulesOf(agent);
    const owners = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: owners.sign,
      home,
    });
    const folder = await sendFolder();
    expect(result).toMatchObject({ status: 'allowed', folder });
    expect(owners.items).toHaveLength(1);
    const after = await rulesOf(agent);
    expect(after.version).toBe(before.version + 1);
    // Only that one folder was added.
    expect(after.jcs).toBe(withFolders(before.doc, [folder]));
    const stats = await lstat(folder);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(await readdir(folder)).toEqual([]);
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o700);
  });

  it('signed rules with other changes and another folder: everything kept, the folder appended', async () => {
    const { agent, owner, code } = await existingAgent();
    const other = join(await realpath(home), 'Work');
    await mkdir(other);
    await signEdit(agent, owner, code, {
      files: { allowedFolders: [other], maxSendSizeMB: 50 },
      proofs: { notarize: 'approval' },
    });
    const before = await rulesOf(agent);
    const owners = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: owners.sign,
      home,
    });
    expect(result.status).toBe('allowed');
    const after = await rulesOf(agent);
    expect(after.version).toBe(before.version + 1);
    expect(after.jcs).toBe(withFolders(before.doc, [other, await sendFolder()]));
  });

  it('the owner reads what is signed before the code: the folder, and that nothing else changes', async () => {
    const { agent, owner, code } = await existingAgent();
    const owners = ownerSigning(() => code);
    await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: owners.sign,
      home,
    });
    const summary = owners.items[0]?.summary ?? '';
    expect(summary).toContain(await sendFolder());
    expect(summary).toMatch(/Nothing else/);
    expect(summary).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('a body wider than the rules plus the folder is never signed (policy widening)', async () => {
    const widen: readonly ((body: MutableJson) => void)[] = [
      (body) => {
        const policy = (body['params'] as MutableJson)['policy'] as MutableJson;
        (policy['contacts'] as MutableJson)['acceptInvites'] = 'auto';
      },
      (body) => {
        const policy = (body['params'] as MutableJson)['policy'] as MutableJson;
        const files = policy['files'] as MutableJson;
        files['allowedFolders'] = [...(files['allowedFolders'] as string[]), '/etc'];
      },
      (body) => {
        const policy = (body['params'] as MutableJson)['policy'] as MutableJson;
        (policy['files'] as MutableJson)['maxSendSizeMB'] = 200;
      },
      (body) => {
        body['agent'] = '0x0000000000000000000000000000000000000001';
      },
      (body) => {
        body['op'] = 'policy.recover';
      },
    ];
    for (const change of widen) {
      const { agent, owner, code } = await existingAgent();
      const before = await rulesOf(agent);
      const spy = spyActions(agent, { alter: (p) => alterPolicy(p, change) });
      const owners = ownerSigning(() => code);
      const result = await setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions: spy.actions,
        sign: owners.sign,
        home,
      });
      expect(result).toEqual({ status: 'not_allowed', reason: 'failed' });
      expect(owners.items).toEqual([]);
      expect(spy.applied).toEqual([]);
      expect((await rulesOf(agent)).jcs).toBe(before.jcs);
      // No half-set state: the folders this run created are gone.
      expect(await exists(join(home, 'AgentLink'))).toBe(false);
      await reset();
    }
  });

  it('a Send folder that already holds files: nothing asked, nothing signed, nothing touched', async () => {
    const { agent, owner, code } = await existingAgent();
    await mkdir(join(home, 'AgentLink', 'Send'), { recursive: true });
    await writeFile(join(home, 'AgentLink', 'Send', 'private.txt'), 'x');
    const before = await rulesOf(agent);
    const owners = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: owners.sign,
      home,
    });
    expect(result).toEqual({ status: 'not_allowed', reason: 'folder_not_empty' });
    expect(owners.items).toEqual([]);
    expect((await rulesOf(agent)).jcs).toBe(before.jcs);
    expect(await readdir(join(home, 'AgentLink', 'Send'))).toEqual(['private.txt']);
  });

  it('a link at either level is refused: nothing signed, the link and its target untouched', async () => {
    for (const linked of ['Send', 'AgentLink'] as const) {
      const { agent, owner, code } = await existingAgent();
      const target = join(dir, `elsewhere-${linked}`);
      await mkdir(target);
      if (linked === 'Send') {
        await mkdir(join(home, 'AgentLink'));
        await symlink(target, join(home, 'AgentLink', 'Send'));
      } else {
        await symlink(target, join(home, 'AgentLink'));
      }
      const owners = ownerSigning(() => code);
      const result = await setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions: agent.client.ownerActions,
        sign: owners.sign,
        home,
      });
      expect(result).toEqual({ status: 'not_allowed', reason: 'folder_unavailable' });
      expect(owners.items).toEqual([]);
      expect((await lstat(join(home, 'AgentLink'))).isSymbolicLink() || linked === 'Send').toBe(
        true,
      );
      expect(await readdir(target)).toEqual([]);
      await reset();
    }
  });

  it('already allowed: nothing asked, nothing signed', async () => {
    const { agent, owner, code } = await existingAgent();
    const first = ownerSigning(() => code);
    await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: first.sign,
      home,
    });
    const before = await rulesOf(agent);
    const again = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: agent.client.ownerActions,
      sign: again.sign,
      home,
    });
    expect(result).toEqual({ status: 'already_allowed', folder: await sendFolder() });
    expect(again.items).toEqual([]);
    expect((await rulesOf(agent)).jcs).toBe(before.jcs);
  });

  it('rules that fail closed: nothing created, nothing signed (never rebuilt from the defaults)', async () => {
    const { agent, owner, code } = await existingAgent();
    const spy = spyActions(agent, {
      load: () => Promise.resolve({ mode: 'fail_closed', problem: 'tampered' } as EffectivePolicy),
    });
    const owners = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: spy.actions,
      sign: owners.sign,
      home,
    });
    expect(result).toEqual({ status: 'not_allowed', reason: 'rules_unreadable' });
    expect(owners.items).toEqual([]);
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('32 folders already: refused before anything is created (06 §3 bound)', async () => {
    const { agent, owner, code } = await existingAgent();
    const base = await agent.client.ownerActions.loadPolicy();
    if (base.mode === 'fail_closed') throw new Error('fail closed');
    const many = Array.from({ length: 32 }, (_, i) => `/data/f${String(i)}`);
    const full = {
      mode: 'signed',
      version: 7,
      policy: { ...base.policy, files: { ...base.policy.files, allowedFolders: many } },
    } as unknown as EffectivePolicy;
    const spy = spyActions(agent, { load: () => Promise.resolve(full) });
    const owners = ownerSigning(() => code);
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: spy.actions,
      sign: owners.sign,
      home,
    });
    expect(result).toEqual({ status: 'not_allowed', reason: 'too_many' });
    expect(owners.items).toEqual([]);
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('a wrong owner code: the error reaches the caller, nothing changes, the folder is removed', async () => {
    const { agent, owner } = await existingAgent();
    const before = await rulesOf(agent);
    const owners = ownerSigning(() => 'WRONG');
    await expect(
      setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions: agent.client.ownerActions,
        sign: owners.sign,
        home,
      }),
    ).rejects.toMatchObject({ code: 'presence_rejected' });
    expect((await rulesOf(agent)).jcs).toBe(before.jcs);
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('core refuses the signed rules: failed, the folder removed', async () => {
    const { agent, owner, code } = await existingAgent();
    const spy = spyActions(agent, {
      apply: () => Promise.resolve({ status: 'rejected', reason: 'version_not_newer' } as never),
    });
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: spy.actions,
      sign: ownerSigning(() => code).sign,
      home,
    });
    expect(result).toEqual({ status: 'not_allowed', reason: 'failed' });
    expect(await exists(join(home, 'AgentLink'))).toBe(false);
  });

  it('apply throws (store outcome unknown): not_confirmed and the folder is kept', async () => {
    const { agent, owner, code } = await existingAgent();
    const spy = spyActions(agent, { apply: () => Promise.reject(new Error('disk')) });
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: spy.actions,
      sign: ownerSigning(() => code).sign,
      home,
    });
    expect(result).toEqual({ status: 'not_confirmed', folder: await sendFolder() });
    expect(await exists(await sendFolder())).toBe(true);
  });

  it('delivery receipts on from an older default: asked once, only then (D-109)', async () => {
    const { agent, owner, code } = await existingAgent();
    // Signed rules (version 1) that core reports as having receipts on from an older default.
    await signEdit(agent, owner, code, { proofs: { notarize: 'approval' } });
    let asked = 0;
    const result = await setUpSendFolder({
      agent: agent.agentId,
      owner,
      actions: spyActions(agent, { olderReceipts: true }).actions,
      sign: ownerSigning(() => code).sign,
      home,
      keepDeliveryReceipts: () => {
        asked += 1;
        return Promise.resolve(false);
      },
    });
    expect(result.status).toBe('allowed');
    expect(asked).toBe(1);

    await reset();
    const other = await existingAgent();
    let askedOther = 0;
    const plain = await setUpSendFolder({
      agent: other.agent.agentId,
      owner: other.owner,
      actions: other.agent.client.ownerActions,
      sign: ownerSigning(() => other.code).sign,
      home,
      keepDeliveryReceipts: () => {
        askedOther += 1;
        return Promise.resolve(true);
      },
    });
    expect(plain.status).toBe('allowed');
    expect(askedOther).toBe(0);
  });
});

// M1-36b-2-d (IR-M1-36b-2-c-1 L1-L3): the AI agent runs as the same OS user (04 §2.5), so it can
// rename, replace or link the Send folder at any moment. The folder the owner checked is pinned (its
// real path and its identity on disk) and must still be exactly that folder, real and empty, just
// before the owner code is asked AND after signing, just before the rules are applied. Otherwise
// nothing is applied (fail closed) and nothing the run did not create is removed.
describe('setUpSendFolder: one folder from the check to the rules (M1-36b-2-d)', () => {
  type Swap = (folder: string) => Promise<void>;
  let elsewhereCount = 0;
  const swaps: readonly (readonly [string, Swap])[] = [
    [
      'a link to another empty folder',
      async (folder) => {
        elsewhereCount += 1;
        const elsewhere = join(dir, `elsewhere-${String(elsewhereCount)}`);
        await mkdir(elsewhere);
        await rename(folder, `${folder}-old`);
        await symlink(elsewhere, folder);
      },
    ],
    [
      'another real, empty folder (rename and replace)',
      async (folder) => {
        await rename(folder, `${folder}-old`);
        await mkdir(folder, { mode: 0o700 });
      },
    ],
    [
      'a file put into it',
      async (folder) => {
        await writeFile(join(folder, 'private.txt'), 'x');
      },
    ],
  ];

  for (const [label, swap] of swaps) {
    it(`replaced by ${label} between the check and the owner code: nothing signed`, async () => {
      const { agent, owner, code } = await existingAgent();
      const before = await rulesOf(agent);
      const folder = await sendFolder();
      const spy = spyActions(agent);
      const prepare = spy.actions.preparePolicyEdit;
      const actions: SendFolderSetupActions = {
        ...spy.actions,
        preparePolicyEdit: async (patch, opts) => {
          await swap(folder);
          return prepare(patch, opts);
        },
      };
      const owners = ownerSigning(() => code);
      const result = await setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions,
        sign: owners.sign,
        home,
      });
      expect(result).toEqual({ status: 'not_allowed', reason: 'failed' });
      expect(owners.items).toEqual([]);
      expect(spy.applied).toEqual([]);
      expect((await rulesOf(agent)).jcs).toBe(before.jcs);
    });

    it(`replaced by ${label} after signing, before the rules apply: nothing applied`, async () => {
      const { agent, owner, code } = await existingAgent();
      const before = await rulesOf(agent);
      const folder = await sendFolder();
      const spy = spyActions(agent);
      const owners = ownerSigning(() => code);
      const result = await setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions: spy.actions,
        sign: async (o, item) => {
          const signature = await owners.sign(o, item);
          await swap(folder);
          return signature;
        },
        home,
      });
      expect(owners.items).toHaveLength(1);
      expect(result).toEqual({ status: 'not_allowed', reason: 'failed' });
      expect(spy.applied).toEqual([]);
      expect((await rulesOf(agent)).jcs).toBe(before.jcs);
    });
  }

  it('the rules already allow ~/AgentLink/Send (the Send form): already allowed, nothing signed', async () => {
    const { agent, owner, code } = await existingAgent();
    const base = await agent.client.ownerActions.loadPolicy();
    if (base.mode === 'fail_closed') throw new Error('fail closed');
    // Every form sending uses for this folder (allowed-path pins it at its real path).
    for (const form of ['~/AgentLink/Send', '~/AgentLink/Send/', `${await sendFolder()}${sep}`]) {
      const rules = {
        mode: 'signed',
        version: 3,
        policy: { ...base.policy, files: { ...base.policy.files, allowedFolders: [form] } },
      } as unknown as EffectivePolicy;
      const spy = spyActions(agent, { load: () => Promise.resolve(rules) });
      const owners = ownerSigning(() => code);
      const result = await setUpSendFolder({
        agent: agent.agentId,
        owner,
        actions: spy.actions,
        sign: owners.sign,
        home,
      });
      expect(result).toEqual({ status: 'already_allowed', folder: await sendFolder() });
      expect(owners.items).toEqual([]);
      expect(spy.applied).toEqual([]);
      expect(await exists(join(home, 'AgentLink'))).toBe(false);
    }
  });
});
