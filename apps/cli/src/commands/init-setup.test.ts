// `agentlink init` (M1-36b; owner decisions D1, D5 of 2026-10-22): the offer to install AgentLink on
// this computer (never without a yes; npx stays the fallback), agents named after their app (the
// name can still be given), and each app's change shown together with its question (UX-B F9).
// The keychain and the install are doubles; the files are real, in a temporary home folder.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, createDispatcher, type DispatchIO } from '../dispatch.js';
import { readAgentConfig } from '../runtime/index.js';
import { writeAppCurrent } from '../runtime/agent-dir.js';
import type { TerminalContext } from '../runtime/guards.js';
import { copy } from '@4thtech-io/mcp-tools/strings/index.js';
import { isAgentlinkOnPath, INSTALL_ARGS } from './global-install.js';
import { INIT_TEXT, createInitHandler, type InitDeps } from './init.js';

const AGENT_ID = `0x${'cd'.repeat(20)}`;
const NOW = 1_800_000_000;
const NPX = 'npx -y @4thtech-io/agentlink';
const INSTALL = 'npm i -g @4thtech-io/agentlink';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };

let home: string;
let outside: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-init36-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-init36-out-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly asked: number;
  readonly installs: number;
}

interface RunOptions {
  readonly terminal?: TerminalContext;
  readonly answers?: readonly string[];
  /** Whether an `agentlink` command is already on PATH. */
  readonly onPath?: boolean;
  /** Whether the install succeeds when it runs. */
  readonly installOk?: boolean;
  readonly prefix?: string;
}

async function init(argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let asked = 0;
  let installs = 0;
  const answers = [...(options.answers ?? [])];
  const deps: InitDeps = {
    home,
    probeKeychain: () => Promise.resolve({ ok: true }),
    createAgent: () => Promise.resolve(AGENT_ID),
    readLine: () => {
      asked += 1;
      return Promise.resolve(answers.shift() ?? '');
    },
    clock: () => NOW,
    platform: 'darwin',
    cliPrefix: () => options.prefix ?? NPX,
    // A successful install puts `agentlink` on PATH, unless the test says otherwise.
    agentlinkOnPath: () => options.onPath ?? (installs > 0 && (options.installOk ?? true)),
    installGlobal: () => {
      installs += 1;
      return Promise.resolve(options.installOk ?? true);
    },
  };
  const dispatch = createDispatcher({ init: createInitHandler(deps) });
  const io: DispatchIO = {
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal: options.terminal ?? PIPE,
    version: '0.0.0',
  };
  const code = await dispatch(['init', ...argv], io);
  return { code, out: out.join('\n'), err: err.join('\n'), asked, installs };
}

const withApp = (text: string, appName: string): string => text.replaceAll('{appName}', appName);

function codeOf(run: Run): string {
  const match = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(run.out);
  if (match?.[1] === undefined) throw new Error('no confirmation code printed');
  return match[1];
}

async function geminiOnPath(): Promise<Record<string, string>> {
  const bin = join(outside, 'gemini-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
  return { PATH: bin };
}

describe('D1: the offer to install AgentLink on this computer', () => {
  it('in a terminal, shows the exact command and asks; a yes installs once', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['y', 'y'] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.asked).toBe(2);
    expect(run.out).toContain(INIT_TEXT.installOffer);
    expect(run.out).toContain(`This runs: ${INSTALL}`);
    expect(run.out).toContain(INIT_TEXT.installQuestion);
    expect(run.installs).toBe(1);
    expect(run.out).toContain(INIT_TEXT.installed);
    // After the install, the owner step uses the installed command.
    expect(run.out).toContain('`agentlink owner init --agent codex`');
    expect(run.out).not.toContain(`${NPX} owner init`);
  });

  it('the question comes after the app changes and before the owner step', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['y', 'n'] });
    const at = (text: string): number => run.out.indexOf(text);
    expect(at(copy('cli.init.apply'))).toBeLessThan(at(INIT_TEXT.installQuestion));
    expect(at(INIT_TEXT.installQuestion)).toBeLessThan(at('owner init'));
  });

  it.each(['', 'n', 'no', 'maybe', 'yes please'])(
    'any answer but yes (%j) installs nothing and keeps npx',
    async (answer) => {
      await mkdir(join(home, '.codex'));
      const run = await init([], { terminal: TTY, answers: ['y', answer] });
      expect(run.code).toBe(EXIT_OK);
      expect(run.installs).toBe(0);
      expect(run.out).toContain(INIT_TEXT.installSkipped);
      expect(run.out).toContain(`\`${NPX} owner init --agent codex\``);
    },
  );

  it('installed but not reachable on PATH: the commands keep the npx form', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['y', 'y'], onPath: false });
    expect(run.installs).toBe(1);
    expect(run.out).toContain(`\`${NPX} owner init --agent codex\``);
  });

  it('a failed install says so plainly and falls back to npx', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['y', 'y'], installOk: false });
    expect(run.installs).toBe(1);
    expect(run.err).toContain(INIT_TEXT.installFailed);
    expect(run.out).toContain(`\`${NPX} owner init --agent codex\``);
    // The app setup itself still succeeded.
    expect(run.code).toBe(EXIT_OK);
  });

  it('is not offered when AgentLink is already installed', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], {
      terminal: TTY,
      answers: ['y'],
      onPath: true,
      prefix: 'agentlink',
    });
    expect(run.asked).toBe(1);
    expect(run.installs).toBe(0);
    expect(run.out).not.toContain(INIT_TEXT.installQuestion);
    expect(run.out).toContain('`agentlink owner init --agent codex`');
  });

  it('run by an agent: never installs and never asks; prints the command for the user', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect(plan.asked).toBe(0);
    expect(plan.installs).toBe(0);
    expect(plan.out).toContain(INIT_TEXT.installTip);
    expect(plan.out).toContain(INSTALL);
    // The re-run line works after the npx install.
    expect(plan.out).toContain(`Then run: ${NPX} init --agent codex --confirm ${codeOf(plan)}`);
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.installs).toBe(0);
    expect(run.out).toContain(INIT_TEXT.installTip);
    expect(run.out).toContain(`\`${NPX} owner init --agent codex\``);
  });

  it('with nothing left to set up, a terminal run still offers the install', async () => {
    await mkdir(join(home, '.codex'));
    await init([], { terminal: TTY, answers: ['y', 'n'] });
    const again = await init([], { terminal: TTY, answers: ['y'] });
    expect(again.out).toContain(INIT_TEXT.nothingToDo);
    expect(again.installs).toBe(1);
  });

  it('the install command is fixed: npm, global, the AgentLink package only', () => {
    expect(INSTALL_ARGS).toEqual(['i', '-g', '@4thtech-io/agentlink']);
  });
});

describe('isAgentlinkOnPath', () => {
  it('finds an agentlink program on PATH, and nothing else counts', async () => {
    const bin = join(outside, 'bin');
    await mkdir(bin);
    expect(isAgentlinkOnPath({ PATH: bin }, 'darwin')).toBe(false);
    await writeFile(join(bin, 'agentlinkx'), '');
    expect(isAgentlinkOnPath({ PATH: bin }, 'darwin')).toBe(false);
    await writeFile(join(bin, 'agentlink'), '#!/bin/sh\n', { mode: 0o755 });
    expect(isAgentlinkOnPath({ PATH: `/nowhere:${bin}` }, 'darwin')).toBe(true);
    expect(isAgentlinkOnPath({}, 'darwin')).toBe(false);
  });

  it('a folder named agentlink is not a program', async () => {
    const bin = join(outside, 'bin2');
    await mkdir(join(bin, 'agentlink'), { recursive: true });
    expect(isAgentlinkOnPath({ PATH: bin }, 'darwin')).toBe(false);
  });
});

describe('D5: agents are named after their app', () => {
  it('one app found: the agent takes its name, and the MCP entry names it', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect(plan.out).toContain('"--agent", "codex"');
    await init(['--confirm', codeOf(plan)]);
    expect((await readAgentConfig(home, 'codex'))?.config.name).toBe('codex');
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
  });

  it('--harness names the app, and so the agent', async () => {
    const plan = await init(['--harness', 'claude-desktop']);
    await init(['--harness', 'claude-desktop', '--confirm', codeOf(plan)]);
    expect((await readAgentConfig(home, 'claude-desktop'))?.config.name).toBe('claude-desktop');
  });

  it('--agent still overrides the name', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init(['--agent', 'work']);
    await init(['--agent', 'work', '--confirm', codeOf(plan)]);
    expect((await readAgentConfig(home, 'work'))?.config.name).toBe('work');
    expect(await readAgentConfig(home, 'codex')).toBeUndefined();
  });

  it('several apps at once share one agent with the usual name', async () => {
    await mkdir(join(home, '.codex'));
    const env = await geminiOnPath();
    const plan = await init([], { terminal: { ...PIPE, env } });
    await init(['--confirm', codeOf(plan)], { terminal: { ...PIPE, env } });
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it('--harness none keeps the usual name', async () => {
    const plan = await init(['--harness', 'none']);
    await init(['--harness', 'none', '--confirm', codeOf(plan)]);
    expect(await readAgentConfig(home, 'default')).toBeDefined();
  });

  it('a computer set up before (an agent with the usual name) keeps using it', async () => {
    const first = await init(['--harness', 'none']);
    await init(['--harness', 'none', '--confirm', codeOf(first)]);
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect(plan.out).not.toContain('--agent');
    expect(plan.out).not.toContain(INIT_TEXT.identity);
  });

  it('IR-M1-36b-1 probe: Codex first, then Gemini, keeps one agent and Codex untouched', async () => {
    await mkdir(join(home, '.codex'));
    const first = await init([]);
    await init(['--confirm', codeOf(first)]);
    const codexBefore = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const env = await geminiOnPath();
    const second = await init([], { terminal: { ...PIPE, env } });
    expect(second.out).not.toContain(INIT_TEXT.identity);
    expect(second.out).not.toContain('Codex already has an entry');
    expect(second.out).toContain(withApp(INIT_TEXT.present, 'Codex'));
    const run = await init(['--confirm', codeOf(second)], { terminal: { ...PIPE, env } });
    expect(run.code).toBe(EXIT_OK);
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(codexBefore);
    expect(
      JSON.parse(await readFile(join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers
        .agentlink.args,
    ).toEqual(['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'codex']);
  });

  it('the only agent is reused for another single app, never a second one', async () => {
    await mkdir(join(home, '.codex'));
    const first = await init([]);
    await init(['--confirm', codeOf(first)]);
    const plan = await init(['--harness', 'opencode']);
    expect(plan.out).not.toContain(INIT_TEXT.identity);
    expect(plan.out).toContain('--agent codex');
  });

  async function twoAgentsAndCodex(): Promise<void> {
    for (const name of ['agent-alpha', 'agent-beta']) {
      const plan = await init(['--agent', name, '--harness', 'none']);
      await init(['--agent', name, '--harness', 'none', '--confirm', codeOf(plan)]);
    }
    await mkdir(join(home, '.codex'));
  }

  it.each([
    ['the owner terminal', TTY],
    ['an AI app', { ...TTY, env: { CLAUDECODE: '1' } }],
  ] as const)(
    'U3-b: several agents and no --agent never ask (%s); the first by name is used',
    async (_label, terminal) => {
      await twoAgentsAndCodex();
      const run = await init([], { terminal });
      expect(run.code).toBe(EXIT_OK);
      expect(run.asked).toBe(0);
      expect(run.err).toBe('');
      expect(run.out).not.toMatch(/Which one|Type its number|1\. agent-alpha/);
      expect(run.out).toContain('--agent agent-alpha');
      expect(await readAgentConfig(home, 'codex')).toBeUndefined();
    },
  );

  it('U3-b: the last used agent (app.json) is the current one', async () => {
    await twoAgentsAndCodex();
    await writeAppCurrent(home, 'agent-beta');
    const run = await init([], { terminal: TTY, answers: ['n'] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toContain('--agent agent-beta');
    expect(run.out).not.toContain('--agent agent-alpha');
  });

  it('U3-b: else the agent an AI app already serves', async () => {
    await twoAgentsAndCodex();
    const set = await init(['--agent', 'agent-beta', '--harness', 'codex']);
    await init(['--agent', 'agent-beta', '--harness', 'codex', '--confirm', codeOf(set)]);
    const run = await init([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toContain(INIT_TEXT.nothingToDo);
    expect(run.out).not.toContain('agent-alpha');
  });

  it('every app name is a valid agent name', async () => {
    const { HARNESSES } = await import('../harness/index.js');
    const { agentNameForApp } = await import('./init.js');
    const { isAgentName } = await import('../runtime/agent-name.js');
    for (const def of HARNESSES) expect(isAgentName(agentNameForApp(def))).toBe(true);
  });
});

describe('UX-B F9: each change is shown right above its question', () => {
  it('in a terminal, the header and diff of an app are printed once, then its question', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['n'] });
    const lines = run.out.split('\n');
    const header = copy('cli.init.changesFor', { appName: 'Codex' });
    expect(lines.filter((l) => l === header)).toHaveLength(1);
    const h = lines.indexOf(header);
    const q = lines.indexOf(copy('cli.init.apply'));
    expect(h).toBeLessThan(q);
    // Only the diff lies between them.
    expect(lines.slice(h + 1, q).every((l) => /^(---|\+\+\+|@@|[+ -]|$)/.test(l))).toBe(true);
  });
});
