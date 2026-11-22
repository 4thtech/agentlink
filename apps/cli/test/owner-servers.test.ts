// NET-CLI (S2; D-158; 06 §8 `agentlink owner servers`; 04 §2.5, §2.6; 11 §5.14; I-4, I-5, I-7).
// - `list` and `test`: read-only, no presence, so they also run piped or from an AI app's terminal.
// - `set` and `reset` †: an interactive terminal with no AI-harness marker (the owner guard, a UX
//   guard, D-67), then @4thtech-io/node's terminal flow: the review first, "Continue?", owner presence
//   at its own prompt, then the one signature (signServerChange, the app's path). Here the node flow
//   is a stand-in that records what it was asked and runs `describe` like the real one.
// - `--no-announce` with the automatic servers on is refused (`mix_in_on`) before anything runs.
// - No MCP tool reaches any of it (I-4 canary at the end).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDate } from '@4thtech-io/mcp-tools/strings/index.js';
import { ADVANCED_TOOLS, TOOLS } from '@4thtech-io/mcp-tools/registry.js';
import type { PrecheckResult } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerCommandHandlers, type OwnerCommandDeps } from '../src/commands/owner/index.js';
import { SERVERS_TEXT } from '../src/commands/owner/servers.js';
import { DISPATCH_TEXT, createDispatcher, helpText } from '../src/dispatch.js';
import type { TerminalContext } from '../src/runtime/guards.js';

const NOW = 1_800_000_000;
const DAY = 86_400;
const OWNER_TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const PIPED: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
const HARNESS: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } };
const HEX = (n: number, bytes: number): string =>
  '0x' + n.toString(16).padStart(2, '0').repeat(bytes);

type ChangeInput = Parameters<NonNullable<OwnerCommandDeps['changeServers']>>[0];
type ChangeOutcome = Awaited<ReturnType<NonNullable<OwnerCommandDeps['changeServers']>>>;

let calls: { request: ChangeInput['request']; review: readonly string[] }[];
let tested: (readonly string[])[];
let refusePresence: boolean;
let outcome: ChangeOutcome;
let testAnswer: readonly PrecheckResult[] | 'busy';
let network: Record<string, unknown>;
let leaving: { url: string; until: number }[];
let probe: unknown;

const precheck = (
  host: string | null,
  outcome: PrecheckResult['outcome'],
  reason: PrecheckResult['reason'] = null,
): PrecheckResult => ({
  host,
  outcome,
  reason,
  roundTripMs: outcome === 'refused' ? null : 140,
  signInRequired: outcome === 'sign_in',
  paymentRequired: false,
});

function deps(): OwnerCommandDeps {
  const client = {
    agentId: HEX(0x11, 20),
    identity: {
      get: () =>
        Promise.resolve({
          agentId: HEX(0x11, 20),
          revoked: false,
          keyEpoch: 0,
          card: { ownerEvm: HEX(1, 20), ownerNostr: HEX(2, 32), ownerEnc: HEX(3, 32) },
        }),
      leavingServers: () => Promise.resolve(leaving),
    },
    network: {
      servers: () => Promise.resolve(network),
      probe: () => Promise.resolve(probe),
    },
  };
  return {
    listAgents: () => Promise.resolve(['alice']),
    open: () =>
      Promise.resolve({
        status: 'ok',
        agent: { name: 'alice', client, store: {}, cipher: {}, close: () => Promise.resolve() },
      }),
    backendOf: () => Promise.resolve('keychain'),
    ask: () => Promise.resolve(''),
    now: () => NOW,
    cardRelays: () => [],
    testServers: (urls: readonly string[]) => {
      tested.push(urls);
      return Promise.resolve(testAnswer);
    },
    // Stands in for @4thtech-io/node changeServersAtTerminal: the review, then presence, then the
    // signature. A refused presence throws like the node flow (nothing is signed).
    changeServers: (input: ChangeInput) => {
      const review = input.describe({
        kind: input.request.kind,
        servers:
          input.request.kind === 'reset'
            ? [
                { host: 'relay.primal.net', role: 'automatic', outcome: 'ready' },
                { host: 'nostr.data.haus', role: 'automatic', outcome: 'ready' },
              ]
            : [
                { host: 'a.example.org', role: 'own', outcome: 'ready' },
                { host: 'b.example.org', role: 'own', outcome: 'slow' },
              ],
        leaving: [{ host: 'old.example.org', until: NOW + 30 * DAY }],
        contacts: 3,
        warnings:
          input.request.kind === 'servers' && !input.request.announce
            ? ['mix_in_off', 'announce_off', 'slow']
            : ['slow'],
      });
      calls.push({ request: input.request, review });
      if (refusePresence) {
        return Promise.reject(
          Object.assign(new Error('presence'), {
            name: 'KeyStoreError',
            code: 'presence_rejected',
          }),
        );
      }
      return Promise.resolve(outcome);
    },
  } as unknown as OwnerCommandDeps;
}

async function run(
  argv: readonly string[],
  terminal: TerminalContext = OWNER_TTY,
): Promise<{ code: number; text: string; out: string[] }> {
  const out: string[] = [];
  const dispatch = createDispatcher(ownerCommandHandlers(deps()));
  const code = await dispatch(['owner', 'servers', ...argv, '--id', 'alice'], {
    output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
    terminal,
    version: '0.0.0',
  });
  return { code, text: out.join('\n'), out };
}

beforeEach(() => {
  calls = [];
  tested = [];
  refusePresence = false;
  outcome = { status: 'changed', contacts: 3, leavingUntil: NOW + 30 * DAY };
  testAnswer = [precheck('a.example.org', 'ready'), precheck('b.example.org', 'slow')];
  network = {
    paused: false,
    mode: 'custom',
    own: ['wss://a.example.org', 'wss://b.example.org', 'wss://relay.primal.net'],
    legacy: [],
    legacyReadUntil: NOW,
    updateDrops: 0,
    mixIn: true,
    announceDefault: true,
    previousUntil: NOW + 20 * DAY,
    change: null,
  };
  leaving = [{ url: 'wss://old.example.org', until: NOW + 20 * DAY }];
  probe = [
    {
      relay: 'wss://a.example.org',
      result: { state: 'ready', connectMs: 50, roundTripMs: 90, signInRequired: false },
    },
    {
      relay: 'wss://b.example.org',
      result: { state: 'unreachable', connectMs: null, roundTripMs: null, signInRequired: null },
    },
  ];
});

describe('agentlink owner servers list (no presence)', () => {
  it('shows the own servers with roles and health, the mix-in, the opt-out and the leaving ones', async () => {
    const r = await run(['list']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('a.example.org');
    expect(r.text).toContain('relay.primal.net');
    expect(r.text).toMatch(/Yours/);
    expect(r.text).toMatch(/Automatic mix-in/);
    expect(r.text).toMatch(/Ready/);
    expect(r.text).toMatch(/Can't reach/);
    expect(r.text).toContain('old.example.org');
    expect(r.text).toContain(formatDate(new Date((NOW + 20 * DAY) * 1000)));
    expect(r.text).toContain(SERVERS_TEXT.mixInOn);
    expect(r.text).toContain(SERVERS_TEXT.announceOn);
    const words = r.text.replace(/[a-z0-9.-]+\.(net|org|pub)\b/g, '');
    expect(words).not.toMatch(/relay|nostr|wallet|\bgas\b|transaction/i);
    expect(r.text).not.toContain('wss://');
  });

  it('bare `owner servers` is list', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('a.example.org');
  });

  it('runs piped and from an AI app terminal (read-only)', async () => {
    expect((await run(['list'], PIPED)).code).toBe(0);
    expect((await run(['list'], HARNESS)).code).toBe(0);
  });

  it('--json: a fixed shape, hosts only', async () => {
    network = { ...network, mixIn: false, announceDefault: false, own: ['wss://a.example.org'] };
    const r = await run(['list', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.text) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(
      ['announceDefault', 'change', 'leaving', 'mixIn', 'mode', 'paused', 'servers'].sort(),
    );
    expect(json['servers']).toEqual([
      { host: 'a.example.org', role: 'own', health: 'ready', roundTripMs: 90 },
    ]);
    expect(json['leaving']).toEqual([{ host: 'old.example.org', until: NOW + 20 * DAY }]);
    expect(json).toMatchObject({ mixIn: false, announceDefault: false, paused: false });
  });
});

describe('agentlink owner servers test (no presence)', () => {
  it('tests the addresses once and prints plain outcomes and reasons', async () => {
    testAnswer = [
      precheck('a.example.org', 'ready'),
      precheck('b.example.org', 'slow'),
      precheck('c.example.org', 'sign_in'),
      precheck('d.example.org', 'refused', 'not_accepted'),
      precheck(null, 'refused', 'not_allowed'),
    ];
    const urls = [
      'wss://a.example.org',
      'wss://b.example.org',
      'wss://c.example.org',
      'wss://d.example.org',
      'wss://user:secret@10.0.0.1',
    ];
    const r = await run(['test', ...urls], PIPED);
    expect(tested).toEqual([urls]);
    expect(r.text).toMatch(/a\.example\.org\s+Ready · 140 ms/);
    expect(r.text).toContain('Ready · slow');
    expect(r.text).toContain('Needs sign-in to read');
    expect(r.text).toContain("Doesn't accept messages");
    expect(r.text).toContain('Not allowed');
    // Never the typed value of an address that failed the URL rule (I-5), nor credentials.
    expect(r.text).not.toContain('secret');
    expect(r.text).not.toContain('10.0.0.1');
    expect(r.code).toBe(1);
  });

  it('exit 0 when every server can be used', async () => {
    const r = await run(['test', 'wss://a.example.org', 'wss://b.example.org']);
    expect(r.code).toBe(0);
  });

  it('--json: one result per address in order, fixed fields', async () => {
    const r = await run(['test', 'wss://a.example.org', 'wss://b.example.org', '--json']);
    const json = JSON.parse(r.text) as { results: Record<string, unknown>[] };
    expect(json.results).toHaveLength(2);
    expect(Object.keys(json.results[0] ?? {}).sort()).toEqual(
      ['host', 'outcome', 'paymentRequired', 'reason', 'roundTripMs', 'signInRequired'].sort(),
    );
    expect(json.results[1]).toMatchObject({ host: 'b.example.org', outcome: 'slow' });
  });

  it('busy (the shared rate budget) is a plain refusal; more than 8 or none is a usage error', async () => {
    testAnswer = 'busy';
    const busy = await run(['test', 'wss://a.example.org']);
    expect(busy.code).toBe(1);
    expect(busy.text).toContain(SERVERS_TEXT.busy);
    const many = Array.from({ length: 9 }, (_, i) => `wss://s${String(i)}.example.org`);
    expect((await run(['test', ...many])).code).toBe(2);
    expect((await run(['test'])).code).toBe(2);
    expect(tested).toHaveLength(1);
  });
});

describe('agentlink owner servers set †', () => {
  const SET = ['set', 'wss://a.example.org', 'wss://b.example.org'];

  it('piped stdin is refused before anything runs', async () => {
    const r = await run(SET, { stdinIsTTY: false, stdoutIsTTY: true, env: {} });
    expect(r.code).toBe(1);
    expect(r.text).toContain(SERVERS_TEXT.runYourself);
    expect(calls).toEqual([]);
    expect(tested).toEqual([]);
  });

  it('an AI-harness marker is refused before anything runs', async () => {
    for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI', 'AI_AGENT']) {
      const r = await run(SET, { stdinIsTTY: true, stdoutIsTTY: true, env: { [marker]: '1' } });
      expect(r.code).toBe(1);
      expect(r.text).toContain(SERVERS_TEXT.runYourself);
    }
    expect(calls).toEqual([]);
  });

  it('with owner presence: the review, then the change; prints when the old servers stop', async () => {
    const r = await run(SET);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({
      kind: 'servers',
      servers: ['wss://a.example.org', 'wss://b.example.org'],
      automatic: true,
      announce: true,
    });
    const review = calls[0]?.review.join('\n') ?? '';
    expect(review).toContain('Use these 2 message servers');
    expect(review).toContain('Nothing changes until you approve.');
    expect(review).toContain('old.example.org');
    expect(review).toContain('Your contacts get your new details once');
    expect(review.replace(/[a-z0-9.-]+\.(net|org|pub)\b/g, '')).not.toMatch(/relay|nostr/i);
    expect(r.text).toContain(SERVERS_TEXT.changed);
    expect(r.text).toContain(
      `Old servers stay readable until ${formatDate(new Date((NOW + 30 * DAY) * 1000))}.`,
    );
  });

  it('without presence nothing changes (a wrong code)', async () => {
    refusePresence = true;
    const r = await run(SET);
    expect(r.code).toBe(1);
    expect(r.text).not.toContain(SERVERS_TEXT.changed);
  });

  it('--no-announce with the automatic servers on is refused (mix_in_on) before anything runs', async () => {
    const r = await run([...SET, '--no-announce']);
    expect(r.code).toBe(1);
    expect(r.text).toContain(SERVERS_TEXT.refused.mix_in_on);
    expect(calls).toEqual([]);
  });

  it('--no-automatic --no-announce: the fully-quiet warning is in the review', async () => {
    const r = await run([...SET, '--no-automatic', '--no-announce']);
    expect(r.code).toBe(0);
    expect(calls[0]?.request).toEqual({
      kind: 'servers',
      servers: ['wss://a.example.org', 'wss://b.example.org'],
      automatic: false,
      announce: false,
    });
    const review = calls[0]?.review.join('\n') ?? '';
    expect(review).toContain('Only your servers will know this ID');
    expect(review).toContain('Only your servers will carry your messages');
  });

  it('the 16 cap: refused with the date it fits from', async () => {
    outcome = { status: 'refused', reason: 'too_many_previous', fitsAt: NOW + 12 * DAY };
    const r = await run(SET);
    expect(r.code).toBe(1);
    expect(r.text).toContain('Too many old servers are still being read');
    expect(r.text).toContain(
      `You can change again from ${formatDate(new Date((NOW + 12 * DAY) * 1000))}, or go back to automatic now.`,
    );
  });

  it('refusals are fixed plain lines', async () => {
    for (const [reason, text] of [
      ['same_list', 'These are already your servers.'],
      ['not_ready', 'Two working servers are needed'],
      ['rotation_pending', 'An earlier change of this ID is still finishing'],
      ['agent_paused', 'Your ID is paused'],
      ['not_applied', "That didn't go through. Your servers didn't change."],
    ] as const) {
      outcome = { status: 'refused', reason };
      const r = await run(SET);
      expect(r.code, reason).toBe(1);
      expect(r.text, reason).toContain(text);
    }
  });

  it('a bad address list is a usage error, nothing echoed; --json is not a set option', async () => {
    expect((await run(['set'])).code).toBe(2);
    const nine = Array.from({ length: 9 }, (_, i) => `wss://s${String(i)}.example.org`);
    expect((await run(['set', ...nine])).code).toBe(2);
    const typed = await run(['set', 'wss://a.example.org', 'not a url zzq']);
    expect(typed.code).toBe(2);
    expect(typed.text).not.toContain('zzq');
    expect((await run([...SET, '--json'])).code).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('agentlink owner servers reset †', () => {
  it('the same guards: piped stdin and an AI-harness marker are refused', async () => {
    expect((await run(['reset'], PIPED)).code).toBe(1);
    expect((await run(['reset'], HARNESS)).text).toContain(SERVERS_TEXT.runYourself);
    expect(calls).toEqual([]);
  });

  it('goes back to automatic and clears the opt-out, with presence', async () => {
    const r = await run(['reset']);
    expect(r.code).toBe(0);
    expect(calls[0]?.request).toEqual({ kind: 'reset' });
    const review = calls[0]?.review.join('\n') ?? '';
    expect(review).toContain("Use AgentLink's automatic servers?");
    expect(review).toContain('Your custom servers stay readable for 30 days');
    expect(r.text).toContain(SERVERS_TEXT.reset);
  });

  it('takes no addresses or flags', async () => {
    expect((await run(['reset', 'wss://a.example.org'])).code).toBe(2);
    expect((await run(['reset', '--no-announce'])).code).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('the owner command and its help', () => {
  it('help names `owner servers`', () => {
    expect(helpText()).toContain('agentlink owner servers');
  });

  it('other owner subcommands still need the owner terminal', async () => {
    const out: string[] = [];
    const dispatch = createDispatcher(ownerCommandHandlers(deps()));
    const code = await dispatch(['owner', 'change-code'], {
      output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
      terminal: PIPED,
      version: '0.0.0',
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain(DISPATCH_TEXT.notInteractive);
  });
});

// I-4 canary: no MCP tool, tool description or MCP server source reaches these commands.
const HERE = dirname(fileURLToPath(import.meta.url));
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('no MCP path to `owner servers` (I-4)', () => {
  it('no tool names or describes it', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      const text = `${tool.name} ${tool.title} ${tool.description} ${JSON.stringify(tool.inputSchema)}`;
      expect(text, tool.name).not.toMatch(/owner servers|changeServers|testOwnServers/i);
    }
  });

  it('no MCP tool or MCP server source names the command module or the node entries', () => {
    const files = [
      ...sources(join(HERE, '..', '..', '..', 'packages', 'mcp-tools', 'src')),
      ...sources(join(HERE, '..', 'src', 'mcp')),
    ];
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /changeServersAtTerminal|testOwnServers|owner\/servers|serversOne|SERVERS_TEXT/,
      );
    }
  });
});
