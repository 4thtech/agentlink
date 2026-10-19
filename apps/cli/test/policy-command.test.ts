// M1-9m (S2): `agentlink policy` †, the owner's allowed folders for sending files (04 §2.5, §4
// "Allowed folders"; 06 §3 `files.allowedFolders`, §8). Two real cores over an in-memory relay
// network and a real file system under a temporary home. The owner signature comes from the crypto
// test seam (MemoryOwnerKeyStore), standing in for @4thtech-io/node's TTY prompt
// (performOwnerOperation), exactly as in contacts-manage.test.ts.
//
// - refused without an interactive terminal or under an AI-app marker, before anything is read;
// - a wrong owner code changes nothing and says so;
// - allow-folder stores the folder's canonical realpath in a new owner-signed `policy.set` (the
//   signature is verified against the owner key), keeping every other rule as it was;
// - relative paths, paths through a symbolic link, the root, the home folder or a folder above it,
//   hidden and protected folders, and missing folders are refused before any owner code is asked;
// - remove-folder takes a folder out again;
// - no MCP tool reaches any of it (I-4);
// - after allow-folder, the core sends a file from that folder instead of returning needs_setup.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  MemoryStore,
  SINGLETON_SLOT,
  expandHome,
  nostrTransport,
  rowKeyOf,
  verifyStoredOwnerAction,
  type ApprovalChannel,
  type FilesPlatform,
  type Sealed,
  type StoreCipher,
} from '@4thtech-io/core';
import {
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  hmacSha256,
  randomBytes,
  type JsonObject,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import type {
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
} from '@4thtech-io/transport-nostr';
import { defaultPolicy } from '@4thtech-io/types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerCommandDeps } from '../src/commands/owner/index.js';
import { policyHandler } from '../src/commands/owner/policy.js';
import { DISPATCH_TEXT, createDispatcher } from '../src/dispatch.js';
import { agentToolContext } from '../src/mcp/command.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { TerminalContext } from '../src/runtime/guards.js';
import type { OpenedAgent } from '../src/runtime/open-agent.js';
import type { ToolContext } from '../src/tools/index.js';

// Each test pairs two agents over the relay double first (real crypto); see contacts-manage.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// --- doubles (as in contacts-manage.test.ts) ----------------------------------------------------------

const PREFIX = 'test-sealed:';

class TestCipher implements StoreCipher {
  seal(
    context: { table: string; column: string; rowKey: string },
    plaintext: string,
  ): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`${PREFIX}${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(
    context: { table: string; column: string; rowKey: string },
    sealed: Sealed,
  ): Promise<string> {
    const parsed = JSON.parse(
      decodeUtf8(decodeBase64url(sealed.slice(PREFIX.length))),
    ) as unknown[];
    if (
      parsed[0] !== context.table ||
      parsed[1] !== context.column ||
      parsed[2] !== context.rowKey
    ) {
      return Promise.reject(new Error('test cipher: wrong context'));
    }
    return Promise.resolve(parsed[3] as string);
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(hmacSha256(new Uint8Array(32).fill(0x1d), data)));
  }
}

interface Filter {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/** A relay network double: stores every EVENT and answers REQ from what it stored. */
class RelayNetwork implements RelayConnector {
  readonly stored = new Map<string, NostrEvent[]>();

  open(target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
    let closed = false;
    const push = (frame: unknown): void => {
      void Promise.resolve().then(() => {
        if (!closed) handlers.onMessage(JSON.stringify(frame));
      });
    };
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        if (frame[0] === 'EVENT') {
          const event = frame[1] as NostrEvent;
          const list = this.stored.get(target.url) ?? [];
          if (!list.some((e) => e.id === event.id)) list.push(event);
          this.stored.set(target.url, list);
          push(['OK', event.id, true, '']);
        } else if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          const filter = frame[2] as Filter;
          const events = (this.stored.get(target.url) ?? []).filter((e) => matches(filter, e));
          for (const e of events.slice(0, filter.limit ?? events.length)) push(['EVENT', subId, e]);
          push(['EOSE', subId]);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  const wanted = filter['#p'];
  if (
    wanted !== undefined &&
    !event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))
  ) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  return filter.until === undefined || event.created_at <= filter.until;
}

const NOW = 1_800_000_000;
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });
const wrongPresence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('wrong horse') });
const silent = createLogger({ name: 'test', sink: () => undefined });

const approvals: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface Agent {
  readonly name: string;
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestCipher;
  readonly owner: MemoryOwnerKeyStore;
  readonly opened: OpenedAgent;
  /** When true, the policy-version mark cannot be read (the G-6 loader fails closed). */
  markBroken: boolean;
}

/** The Node files platform's allowed-folder half: `~` expanded, realpath of each existing folder. */
function filesPlatform(home: string): FilesPlatform {
  return {
    flavor: 'posix',
    allowedFolderRealpaths: async (folders) => {
      const out: string[] = [];
      for (const folder of folders) {
        try {
          out.push(await realpath(expandHome(folder, home, 'posix')));
        } catch {
          // A missing folder allows nothing.
        }
      }
      return out;
    },
    download: () => {
      throw new Error('not used');
    },
    inbox: () => Promise.reject(new Error('not used')),
  };
}

async function makeAgent(n: number, name: string, net: RelayNetwork, home: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const owner = new MemoryOwnerKeyStore(seed(100 + n), presence());
  let mark = 0;
  const state = { markBroken: false };
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(n)),
    store,
    cipher,
    approvals,
    clock: () => NOW,
    transport: nostrTransport({ connector: net, addressCheck: 'platform' }),
    files: filesPlatform(home),
    policyMark: {
      read: () =>
        state.markBroken ? Promise.reject(new Error('mark unavailable')) : Promise.resolve(mark),
      raise: (v: number) => {
        mark = Math.max(mark, v);
        return Promise.resolve(mark);
      },
    },
    logger: silent,
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: [`wss://one.relay-${name}.net`, `wss://two.relay-${name}.net`],
  });
  await session.close();
  const opened = {
    name,
    agentId: client.agentId,
    paths: {},
    client,
    approvals,
    close: () => Promise.resolve(),
  } as unknown as OpenedAgent;
  return Object.assign(state, { name, client, store, cipher, owner, opened });
}

async function sign(
  agent: Agent,
  body: JsonObject,
  using: () => { kind: 'passphrase'; secret: Uint8Array } = presence,
): Promise<{ body: JsonObject; sig: string }> {
  const session = await agent.owner.unlock(using());
  try {
    return { body, sig: await session.signOwnerAction(body) };
  } finally {
    await session.close();
  }
}

/** Pairs two agents; the invitee first applies a v1 policy that auto-accepts invites. */
async function pair(inviter: Agent, invitee: Agent): Promise<void> {
  const policy = defaultPolicy();
  policy.contacts.acceptInvites = 'auto';
  const keys = await invitee.owner.getPublicKeys();
  const applied = await invitee.client.ownerActions.apply(
    await sign(invitee, {
      v: 1,
      agent: invitee.client.agentId,
      owner: encodeHex(keys.ownerNostr),
      op: 'policy.set',
      params: { version: 1, policy: policy as unknown as JsonObject },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt: NOW,
      expiresAt: NOW + 600,
    }),
  );
  expect(applied.status).toBe('applied');
  const invite = await inviter.client.pairing.createInvite();
  const started = await invitee.client.pairing.acceptInvite({
    link: invite.inviteUrl,
    allowed: true,
  });
  expect(started.status).toBe('pending');
  await invitee.client.outbox.processDue();
  await inviter.client.syncInbox();
  await inviter.client.outbox.processDue();
  await invitee.client.syncInbox();
}

async function connect(context: ToolContext): Promise<Client> {
  const server = createMcpServer(context, '0.0.0-test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

// --- the world: alice (the owner here) is paired with bob ------------------------------------------

const OWNER_TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

let root: string;
let home: string;
let net: RelayNetwork;
let alice: Agent;
let bob: Agent;
/** One entry per owner-code prompt (one owner operation each). */
let codeEntries: string[];
let summaries: string[];
let ownerPresence: () => { kind: 'passphrase'; secret: Uint8Array };
let run: (argv: string[], terminal?: TerminalContext) => Promise<Run>;

beforeEach(async () => {
  // realpath: on macOS the temporary folder itself sits behind the /var → /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-policy-')));
  home = join(root, 'home', 'tali');
  for (const dir of ['Work', 'Work/sub', 'Other', '.hidden', '.ssh', '.agentlink']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  writeFileSync(join(home, 'Work', 'report.txt'), 'quarterly numbers');
  writeFileSync(join(home, 'notes.txt'), 'not a folder');
  symlinkSync(join(home, 'Work'), join(home, 'WorkLink'));
  symlinkSync(home, join(root, 'home', 'link-to-tali'));

  net = new RelayNetwork();
  alice = await makeAgent(1, 'alice', net, home);
  bob = await makeAgent(2, 'bob', net, home);
  await pair(bob, alice); // alice is the invitee: her rules are at version 1
  codeEntries = [];
  summaries = [];
  ownerPresence = presence;

  const ownerDeps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve(['alice']),
    open: () =>
      Promise.resolve({
        status: 'ok',
        agent: {
          name: 'alice',
          client: alice.client,
          store: alice.store,
          cipher: alice.cipher,
          close: () => Promise.resolve(),
        },
      }),
    backendOf: () => Promise.resolve('keychain'),
    initOwner: () => Promise.reject(new Error('not used')),
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: () => Promise.reject(new Error('not used')),
    decide: () => Promise.reject(new Error('not used')),
    // Stands in for @4thtech-io/node's performOwnerOperation: the summary is shown, the owner code is
    // read once, and exactly the given object is signed. A wrong code is `presence_rejected`.
    signOwnerAction: async (_owner, item) => {
      if (item.kind !== 'owner-action') throw new Error('unexpected');
      codeEntries.push(String(item.action['op']));
      summaries.push(item.summary);
      return { kind: 'owner-action', signed: await sign(alice, item.action, ownerPresence) };
    },
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => [],
  };
  const dispatch = createDispatcher({ policy: policyHandler(ownerDeps, { home }) });
  run = async (argv, terminal = OWNER_TTY) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch([...argv, '--agent', 'alice'], {
      output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
      terminal,
      version: '0.0.0',
    });
    return { code, out, err, text: [...out, ...err].join('\n') };
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const loaded = () => alice.client.ownerActions.loadPolicy();

async function folders(): Promise<readonly string[]> {
  const policy = await loaded();
  if (policy.mode === 'fail_closed') throw new Error('fail closed');
  return policy.policy.files.allowedFolders;
}

async function version(): Promise<number | undefined> {
  const policy = await loaded();
  return policy.mode === 'signed' ? policy.version : undefined;
}

/** A file as the Node platform hands it to the core (realpath, size, open), recording the open. */
function outgoing(path: string) {
  let opened = false;
  return {
    file: {
      realpath: realpathSync(path),
      size: statSync(path).size,
      open: () => {
        opened = true;
        return Promise.resolve(new Uint8Array(readFileSync(path)));
      },
    },
    opened: () => opened,
  };
}

// --- tests -----------------------------------------------------------------------------------------

describe('owner presence and the AI (04 §2.5, §2.8; I-4; 06 §8)', () => {
  const commands = [
    ['policy', 'show'],
    ['policy', 'allow-folder', '~/Work'],
    ['policy', 'remove-folder', '~/Work'],
  ];

  it.each(commands)('`%s %s` is refused without an interactive terminal', async (...argv) => {
    for (const terminal of [
      { stdinIsTTY: false, stdoutIsTTY: true, env: {} },
      { stdinIsTTY: true, stdoutIsTTY: false, env: {} },
    ]) {
      const result = await run(argv, terminal);
      expect(result.code).toBe(1);
      expect(result.err).toEqual([DISPATCH_TEXT.notInteractive]);
    }
    expect(codeEntries).toEqual([]);
    expect(await folders()).toEqual([]);
    expect(await version()).toBe(1);
  });

  it.each(commands)('`%s %s` is refused under an AI-app marker', async (...argv) => {
    const result = await run(argv, { ...OWNER_TTY, env: { CLAUDECODE: '1' } });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([DISPATCH_TEXT.harnessDetected]);
    expect(codeEntries).toEqual([]);
    expect(await version()).toBe(1);
  });

  it('a wrong owner code changes nothing and says so (one try per run; nothing signed)', async () => {
    ownerPresence = wrongPresence;
    const result = await run(['policy', 'allow-folder', join(home, 'Work')]);
    expect(result.code).toBe(1);
    expect(codeEntries).toEqual(['policy.set']);
    expect(result.err.join('\n')).toMatch(/owner code/i);
    expect(result.err.join('\n')).toMatch(/Nothing was changed/);
    expect(result.text).not.toContain('wrong horse');
    expect(await folders()).toEqual([]);
    expect(await version()).toBe(1);
    // The next run asks again: nothing is remembered between runs.
    ownerPresence = presence;
    expect((await run(['policy', 'allow-folder', join(home, 'Work')])).code).toBe(0);
    expect(codeEntries).toEqual(['policy.set', 'policy.set']);
  });
});

describe('policy allow-folder <path> †', () => {
  it('stores the canonical realpath in a new owner-signed policy, other rules unchanged', async () => {
    const before = await loaded();
    const result = await run(['policy', 'allow-folder', join(home, 'Work')]);
    expect(result.code).toBe(0);
    expect(codeEntries).toEqual(['policy.set']);
    // The owner sees the exact folder before the owner code.
    expect(summaries[0]).toContain(join(home, 'Work'));
    expect(await folders()).toEqual([join(home, 'Work')]);
    expect(await version()).toBe(2);
    const after = await loaded();
    if (before.mode === 'fail_closed' || after.mode === 'fail_closed') throw new Error('closed');
    expect({ ...after.policy, files: { ...after.policy.files, allowedFolders: [] } }).toEqual(
      before.policy,
    );
    expect(after.policy.contacts.acceptInvites).toBe('auto');
  });

  it('the stored policy is signed by the owner key (verified), and by no other', async () => {
    expect((await run(['policy', 'allow-folder', join(home, 'Work')])).code).toBe(0);
    const row = await alice.store.transaction((tx) => tx.get('policies', { slot: SINGLETON_SLOT }));
    expect(row).toBeDefined();
    const text = await alice.cipher.open(
      { table: 'policies', column: 'signed_json', rowKey: rowKeyOf([SINGLETON_SLOT]) },
      row?.signed_json as Sealed,
    );
    // The card spells it `0x` + 64 hex (04 §2.4.1).
    const ownerNostr = `0x${encodeHex((await alice.owner.getPublicKeys()).ownerNostr)}`;
    const verified = verifyStoredOwnerAction(text, { agent: alice.client.agentId, ownerNostr });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.signed.body.op).toBe('policy.set');
    const params = verified.signed.body.params as {
      version: number;
      policy: { files: { allowedFolders: string[] } };
    };
    expect(params.version).toBe(2);
    expect(params.policy.files.allowedFolders).toEqual([join(home, 'Work')]);
    const otherOwner = `0x${encodeHex((await bob.owner.getPublicKeys()).ownerNostr)}`;
    expect(
      verifyStoredOwnerAction(text, { agent: alice.client.agentId, ownerNostr: otherOwner }).ok,
    ).toBe(false);
  });

  it('`~/Work/` stores the same absolute realpath, never `~`; allowing it again signs nothing', async () => {
    expect((await run(['policy', 'allow-folder', '~/Work/'])).code).toBe(0);
    expect(await folders()).toEqual([join(home, 'Work')]);
    const again = await run(['policy', 'allow-folder', join(home, 'Work')]);
    expect(again.code).toBe(0);
    expect(codeEntries).toEqual(['policy.set']);
    expect(await version()).toBe(2);
  });

  it('a second folder is added next to the first', async () => {
    expect((await run(['policy', 'allow-folder', join(home, 'Work')])).code).toBe(0);
    expect((await run(['policy', 'allow-folder', join(home, 'Other')])).code).toBe(0);
    expect(await folders()).toEqual([join(home, 'Work'), join(home, 'Other')]);
    expect(await version()).toBe(3);
  });

  const refused: [string, () => string][] = [
    ['a relative path', () => 'Work'],
    ['a dot path', () => './Work'],
    ['a path with ..', () => `${join(home, 'Other')}/../Work`],
    ['a symbolic link', () => join(home, 'WorkLink')],
    ['a path through a linked folder', () => join(root, 'home', 'link-to-tali', 'Work')],
    ['the root folder', () => '/'],
    ['the home folder', () => home],
    ['the home folder as ~', () => '~'],
    ['a folder above the home folder', () => join(root, 'home')],
    ['a hidden folder', () => join(home, '.hidden')],
    ['~/.ssh', () => '~/.ssh'],
    ['~/.agentlink', () => join(home, '.agentlink')],
    ['a missing folder', () => join(home, 'Missing')],
    ['a file', () => join(home, 'notes.txt')],
    ['a ~user path', () => '~bob/Work'],
    ['a control character', () => `${join(home, 'Work')}\u001b[31m`],
  ];

  it.each(refused)('refuses %s before any owner code, changing nothing', async (_label, arg) => {
    const result = await run(['policy', 'allow-folder', arg()]);
    expect(result.code).not.toBe(0);
    expect(codeEntries).toEqual([]);
    expect(await folders()).toEqual([]);
    expect(await version()).toBe(1);
    expect(result.text).not.toContain('\u001b');
  });

  it('a symbolic link is refused with the folder’s real path to use instead', async () => {
    const result = await run(['policy', 'allow-folder', join(home, 'WorkLink')]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain(join(home, 'Work'));
  });

  it('refuses when the rules can’t be read (fail closed), never starting from the defaults', async () => {
    alice.markBroken = true;
    const result = await run(['policy', 'allow-folder', join(home, 'Work')]);
    expect(result.code).toBe(1);
    expect(codeEntries).toEqual([]);
    alice.markBroken = false;
    expect(await version()).toBe(1);
  });

  it('refuses a 33rd folder (06 §3 bound) before any owner code', async () => {
    for (let i = 0; i < 33; i += 1) {
      mkdirSync(join(home, 'Many', `f${String(i)}`), { recursive: true });
    }
    for (let i = 0; i < 32; i += 1) {
      const added = await run(['policy', 'allow-folder', join(home, 'Many', `f${String(i)}`)]);
      expect(added.code).toBe(0);
    }
    const entries = codeEntries.length;
    const result = await run(['policy', 'allow-folder', join(home, 'Many', 'f32')]);
    expect(result.code).toBe(1);
    expect(codeEntries).toHaveLength(entries);
    expect(await folders()).toHaveLength(32);
  });
});

describe('policy remove-folder <path> †', () => {
  it('takes an allowed folder out with one owner operation', async () => {
    expect((await run(['policy', 'allow-folder', join(home, 'Work')])).code).toBe(0);
    expect((await run(['policy', 'allow-folder', join(home, 'Other')])).code).toBe(0);
    const removed = await run(['policy', 'remove-folder', '~/Work']);
    expect(removed.code).toBe(0);
    expect(summaries[2]).toContain(join(home, 'Work'));
    expect(await folders()).toEqual([join(home, 'Other')]);
    expect(await version()).toBe(4);
  });

  it('works for a folder that no longer exists', async () => {
    expect((await run(['policy', 'allow-folder', join(home, 'Other')])).code).toBe(0);
    rmSync(join(home, 'Other'), { recursive: true });
    expect((await run(['policy', 'remove-folder', join(home, 'Other')])).code).toBe(0);
    expect(await folders()).toEqual([]);
  });

  it('a folder that is not allowed: nothing to sign, an error', async () => {
    const result = await run(['policy', 'remove-folder', join(home, 'Work')]);
    expect(result.code).toBe(1);
    expect(codeEntries).toEqual([]);
    expect(await version()).toBe(1);
  });
});

describe('policy show †', () => {
  it('lists the allowed folders without asking for the owner code', async () => {
    const empty = await run(['policy', 'show']);
    expect(empty.code).toBe(0);
    expect(empty.text).toMatch(/No folder is allowed/);
    expect((await run(['policy', 'allow-folder', join(home, 'Work')])).code).toBe(0);
    const shown = await run(['policy', 'show']);
    expect(shown.code).toBe(0);
    expect(shown.text).toContain(join(home, 'Work'));
    expect(codeEntries).toEqual(['policy.set']);
  });

  it('wrong arguments are a usage error, echoing nothing', async () => {
    for (const argv of [
      ['policy'],
      ['policy', 'allow-folder'],
      ['policy', 'allow-folder', '/a', '/b'],
      ['policy', 'nonsense-subcommand'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.text).not.toContain('nonsense-subcommand');
    }
    expect(codeEntries).toEqual([]);
  });
});

describe('no MCP tool reaches the policy (I-4)', () => {
  it('the MCP server lists no policy or folder tool, and refuses a made-up one', async () => {
    const mcp = await connect(agentToolContext(alice.opened, silent));
    const tools = await mcp.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const tool of tools.tools) {
      expect(tool.name).not.toMatch(/polic|folder|rule/i);
      expect(Object.keys(tool.inputSchema.properties ?? {}).join(',')).not.toMatch(
        /polic|allowedFolder/i,
      );
    }
    // A made-up tool name is answered with a refusal (or a protocol error), never `ok`.
    const made = await mcp
      .callTool({ name: 'agentlink_policy', arguments: { allowFolder: home } })
      .then((r) => (r.structuredContent as Record<string, unknown> | undefined)?.['status'])
      .catch(() => 'protocol_error');
    expect(made).toBeDefined();
    expect(made).not.toBe('ok');
    expect(await version()).toBe(1);
  });

  it('nothing on the MCP side imports an owner command or builds a policy.set', () => {
    const files = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(new URL(`${e.name}/`, dir))
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
            ? [new URL(e.name, dir)]
            : [],
      );
    const mcpSide = [
      ...files(new URL('../src/tools/', import.meta.url)),
      ...files(new URL('../src/mcp/', import.meta.url)),
    ];
    expect(mcpSide.length).toBeGreaterThan(5);
    for (const file of mcpSide) {
      const text = readFileSync(file, 'utf8');
      // An import (static or dynamic) of an owner command, or code that names the op.
      expect(text).not.toMatch(/(from|import\()\s*['"][^'"]*commands\/owner/);
      expect(text).not.toMatch(/['"]policy\.set['"]/);
    }
  });
});

describe('end to end: allowing a folder makes file sending work (06 §2.3)', () => {
  it('before: needs_setup and the file is never opened; after allow-folder: sent', async () => {
    const before = outgoing(join(home, 'Work', 'report.txt'));
    const refused = await alice.client.sendMessage({
      to: bob.client.agentId,
      text: 'the report',
      files: [before.file],
    });
    expect(refused.status).toBe('needs_setup');
    expect(before.opened()).toBe(false);

    expect((await run(['policy', 'allow-folder', '~/Work'])).code).toBe(0);

    const after = outgoing(join(home, 'Work', 'report.txt'));
    const sent = await alice.client.sendMessage({
      to: bob.client.agentId,
      text: 'the report',
      files: [after.file],
    });
    expect(sent.status).toBe('ok');
    expect(after.opened()).toBe(true);
  });

  it('after remove-folder, sending from it needs setup again', async () => {
    expect((await run(['policy', 'allow-folder', '~/Work'])).code).toBe(0);
    expect((await run(['policy', 'remove-folder', '~/Work'])).code).toBe(0);
    const again = outgoing(join(home, 'Work', 'report.txt'));
    const result = await alice.client.sendMessage({
      to: bob.client.agentId,
      text: 'the report',
      files: [again.file],
    });
    expect(result.status).toBe('needs_setup');
    expect(again.opened()).toBe(false);
  });
});
