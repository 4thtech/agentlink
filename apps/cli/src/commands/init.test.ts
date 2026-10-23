// `agentlink init` (M1-9a): harness detection, the exact diff per harness, confirmation (prompt and
// one-time code), refusal without it, malformed configs, unsafe paths and agent names. The keychain
// is a double; the files are real, in a temporary home folder.
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeychainProbe } from '@4thtech-io/node';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  createDispatcher,
  type DispatchIO,
} from '../dispatch.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { RUNTIME_MESSAGES } from '../runtime/errors.js';
import { readAgentConfig } from '../runtime/index.js';
import type { TerminalContext } from '../runtime/guards.js';
import { HARNESSES } from '../harness/index.js';
import { copy } from '../tools/strings/index.js';
import { INIT_TEXT, createInitHandler, type InitDeps } from './init.js';

const POSIX = process.platform !== 'win32';
const AGENT_ID = `0x${'ab'.repeat(20)}`;
const NOW = 1_800_000_000;
const NO_KEYCHAIN_COPY =
  "This machine has no system keychain (common in containers, WSL and SSH sessions), so AgentLink can't protect your agent's identity here yet. To keep it in a passphrase-locked file instead, run `agentlink init --keystore file` yourself, in your own terminal.";

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
const AGENT_RUN: TerminalContext = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  env: { CLAUDECODE: '1' },
};

let home: string;
let outside: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-init-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-init-out-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly created: number;
  readonly asked: number;
}

interface RunOptions {
  readonly terminal?: TerminalContext;
  readonly probe?: KeychainProbe;
  readonly answers?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

async function init(argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let created = 0;
  let asked = 0;
  const answers = [...(options.answers ?? [])];
  const deps: InitDeps = {
    home,
    probeKeychain: () => Promise.resolve(options.probe ?? { ok: true }),
    createAgent: () => {
      created += 1;
      return Promise.resolve(AGENT_ID);
    },
    readLine: () => {
      asked += 1;
      return Promise.resolve(answers.shift() ?? '');
    },
    clock: () => NOW,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const dispatch = createDispatcher({ init: createInitHandler(deps) });
  const io: DispatchIO = {
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal: options.terminal ?? PIPE,
    version: '0.0.0',
  };
  const code = await dispatch(['init', ...argv], io);
  return { code, out: out.join('\n'), err: err.join('\n'), created, asked };
}

/** The confirmation code printed by an agent-run `init`. */
function codeOf(run: Run): string {
  const match = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(run.out);
  if (match?.[1] === undefined) throw new Error('no confirmation code printed');
  return match[1];
}

/** INIT_TEXT with the M1-36a command prefix filled in, as printed here (run through vitest, not npx). */
const withPrefix = (text: string): string => text.replaceAll('{prefix}', cliPrefix());

const read = (...parts: string[]): Promise<string> => readFile(join(home, ...parts), 'utf8');
const exists = (...parts: string[]): Promise<boolean> =>
  readFile(join(home, ...parts)).then(
    () => true,
    () => false,
  );
const names = (): Promise<string[]> => readdir(home);

/** A `gemini` program on a PATH of its own: how Gemini CLI looks installed without a settings file (M1-9w). */
async function geminiOnPath(): Promise<Record<string, string>> {
  const bin = join(outside, 'gemini-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
  return { PATH: bin };
}

const CLAUDE_JSON = `${JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'x', env: { KEY: 'v' } } } }, null, 2)}\n`;

describe('detection', () => {
  it('finds nothing and says so, then still creates the agent identity on confirmation', async () => {
    const plan = await init([], { platform: 'darwin' });
    expect(plan.code).toBe(EXIT_OK);
    expect(plan.out).toContain(
      "didn't find Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode, Antigravity, Cursor or Windsurf",
    );
    expect((await init([], { platform: 'linux' })).out).toContain(
      "didn't find Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, Cursor or Windsurf",
    );
    expect(plan.created).toBe(0);
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.created).toBe(1);
    expect((await readAgentConfig(home, 'default'))?.config.agentId).toBe(AGENT_ID);
  });

  it('detects a harness by its folder', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect(plan.out).toContain(copy('cli.init.found', { count: 1 }));
    expect(plan.out).toContain('Codex');
    expect(plan.out).not.toContain('Gemini CLI');
  });

  it('Gemini CLI: a home with only ~/.gemini/config/mcp_config.json proposes Antigravity, not Gemini CLI (M1-9w)', async () => {
    await mkdir(join(home, '.gemini', 'config'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, '.gemini', 'config', 'mcp_config.json'), '{}\n');
    const plan = await init([]);
    expect(plan.out).toContain('Antigravity');
    expect(plan.out).not.toContain('Gemini CLI');
    expect(plan.out).toContain(copy('cli.init.found', { count: 1 }));
  });

  it('Gemini CLI: ~/.gemini/settings.json detects it, and a bare ~/.gemini folder does not', async () => {
    await mkdir(join(home, '.gemini'), { mode: 0o700 });
    expect((await init([])).out).not.toContain(copy('cli.init.found', { count: 1 }));
    await writeFile(join(home, '.gemini', 'settings.json'), '{}\n');
    expect((await init([])).out).toContain('\n  Gemini CLI');
  });

  it('Gemini CLI: the gemini binary on PATH detects it', async () => {
    const plan = await init([], { terminal: { ...PIPE, env: await geminiOnPath() } });
    expect(plan.out).toContain('\n  Gemini CLI');
  });

  it('Claude Desktop is detected by its config folder on macOS and Windows, never on Linux', async () => {
    await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    await mkdir(join(home, 'AppData', 'Roaming', 'Claude'), { recursive: true });
    expect((await init([], { platform: 'darwin' })).out).toContain('Claude Desktop');
    expect((await init([], { platform: 'win32' })).out).toContain('Claude Desktop');
    expect((await init([], { platform: 'linux' })).out).not.toContain('Claude Desktop');
  });
});

describe('Claude Desktop (M1-9w)', () => {
  const MAC = ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'];
  const WIN = ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'];
  // M1-36b (D5): one app, so the agent is named after it.
  const ENTRY = {
    command: 'npx',
    args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'claude-desktop'],
  };
  const cases: [NodeJS.Platform, string[], string][] = [
    ['darwin', MAC, '~/Library/Application Support/Claude/claude_desktop_config.json'],
    ['win32', WIN, '~/AppData/Roaming/Claude/claude_desktop_config.json'],
  ];

  for (const [platform, parts, shown] of cases) {
    it(`${platform}: no config creates the file with only the entry, after confirmation`, async () => {
      const plan = await init(['--harness', 'claude-desktop'], { platform });
      expect(plan.code).toBe(EXIT_OK);
      expect(plan.out).toContain(`--- a/${shown}`);
      expect(await exists(...parts)).toBe(false);
      const run = await init(['--harness', 'claude-desktop', '--confirm', codeOf(plan)], {
        platform,
      });
      expect(run.code).toBe(EXIT_OK);
      expect(JSON.parse(await read(...parts))).toEqual({ mcpServers: { agentlink: ENTRY } });
      expect(await exists('.claude.json')).toBe(false);
      expect(run.out).toContain(INIT_TEXT.restartDesktop);
      expect(run.out).not.toContain(copy('cli.init.restart', { appName: 'Claude Desktop' }));
      expect(INIT_TEXT.restartDesktop).toContain('Connectors');
    });

    it(`${platform}: other servers and settings are preserved, with a backup`, async () => {
      const dir = join(home, ...parts.slice(0, -1));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const before = `${JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'y' } } }, null, 2)}\n`;
      await writeFile(join(home, ...parts), before);
      const plan = await init(['--harness', 'claude-desktop'], { platform });
      expect(plan.out).toContain(`+++ b/${shown}`);
      await init(['--harness', 'claude-desktop', '--confirm', codeOf(plan)], { platform });
      expect(JSON.parse(await read(...parts))).toEqual({
        theme: 'x',
        mcpServers: { other: { command: 'y' }, agentlink: ENTRY },
      });
      const backups = (await readdir(dir)).filter((n) => n !== 'claude_desktop_config.json');
      expect(backups).toHaveLength(1);
    });

    it(`${platform}: malformed JSON is reported and never written`, async () => {
      await mkdir(join(home, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      await writeFile(join(home, ...parts), '{ not json');
      const run = await init(['--harness', 'claude-desktop'], { platform });
      expect(run.code).toBe(EXIT_FAILED);
      expect(run.err).toContain('Claude Desktop');
      expect(run.out).not.toContain('--confirm');
      expect(await read(...parts)).toBe('{ not json');
    });
  }

  it('Linux: says Claude Desktop is not available, and writes nothing', async () => {
    const run = await init(['--harness', 'claude-desktop'], { platform: 'linux' });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toContain("Claude Desktop isn't available on this computer's system");
    expect(run.created).toBe(0);
    expect(await names()).toEqual([]);
  });

  it('a code for Claude Desktop does not confirm Claude Code or another system', async () => {
    const plan = await init(['--harness', 'claude-desktop'], { platform: 'darwin' });
    const other = await init(['--harness', 'claude-code', '--confirm', codeOf(plan)], {
      platform: 'darwin',
    });
    expect(other.code).toBe(EXIT_FAILED);
    expect(await exists(...MAC)).toBe(false);
    const win = await init(['--harness', 'claude-desktop', '--confirm', codeOf(plan)], {
      platform: 'win32',
    });
    expect(win.code).toBe(EXIT_FAILED);
    expect(await exists(...WIN)).toBe(false);
  });
});

describe('the exact diff of each harness', () => {
  it('Claude Code: ~/.claude.json keeps its other servers, and only adds lines', async () => {
    await writeFile(join(home, '.claude.json'), CLAUDE_JSON, { mode: 0o600 });
    const plan = await init([]);
    expect(plan.out).toContain(copy('cli.init.changesFor', { appName: 'Claude Code' }));
    const lines = plan.out.split('\n');
    const start = lines.indexOf('--- a/~/.claude.json');
    expect(lines.slice(start, start + 15)).toEqual([
      '--- a/~/.claude.json',
      '+++ b/~/.claude.json',
      '@@ -3,0 +4,12 @@',
      '+    "agentlink": {',
      '+      "type": "stdio",',
      '+      "command": "npx",',
      '+      "args": [',
      '+        "-y",',
      '+        "@4thtech-io/agentlink",',
      '+        "mcp",',
      '+        "--agent",',
      '+        "claude-code"',
      '+      ],',
      '+      "env": {}',
      '+    },',
    ]);
    expect(plan.out).not.toContain('KEY');
    expect(await read('.claude.json')).toBe(CLAUDE_JSON);
  });

  it('Claude Code: writes the merged file after confirmation, with a backup', async () => {
    await writeFile(join(home, '.claude.json'), CLAUDE_JSON, { mode: 0o600 });
    const plan = await init([]);
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_OK);
    const written = JSON.parse(await read('.claude.json'));
    expect(written.mcpServers.agentlink).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'claude-code'],
      env: {},
    });
    expect(written.mcpServers.other).toEqual({ command: 'x', env: { KEY: 'v' } });
    expect(written.numStartups).toBe(7);
    expect(await read(`.claude.json.agentlink-backup-${NOW}`)).toBe(CLAUDE_JSON);
    expect(run.out).toContain(copy('cli.init.restart', { appName: 'Claude Code' }));
  });

  it('Gemini CLI: ~/.gemini/settings.json gets command and args only', async () => {
    await mkdir(join(home, '.gemini'));
    await writeFile(
      join(home, '.gemini', 'settings.json'),
      `${JSON.stringify({ theme: 'x' }, null, 2)}\n`,
    );
    const plan = await init([]);
    expect(plan.out).toContain('--- a/~/.gemini/settings.json');
    expect(plan.out).toContain('+  "mcpServers": {');
    expect(plan.out).toContain('+      "command": "npx",');
    expect(plan.out).not.toContain('"type"');
    await init(['--confirm', codeOf(plan)]);
    expect(JSON.parse(await read('.gemini', 'settings.json'))).toEqual({
      mcpServers: {
        agentlink: {
          command: 'npx',
          args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'gemini-cli'],
        },
      },
      theme: 'x',
    });
  });

  it('Codex: the TOML diff for ~/.codex/config.toml, written without `codex mcp add`', async () => {
    await mkdir(join(home, '.codex'));
    const before = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    await writeFile(join(home, '.codex', 'config.toml'), before);
    const plan = await init([]);
    const lines = plan.out.split('\n');
    const start = lines.indexOf('--- a/~/.codex/config.toml');
    expect(lines.slice(start, start + 7)).toEqual([
      '--- a/~/.codex/config.toml',
      '+++ b/~/.codex/config.toml',
      '@@ -4,0 +5,4 @@',
      '+',
      '+[mcp_servers.agentlink]',
      '+command = "npx"',
      '+args = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "codex"]',
    ]);
    await init(['--confirm', codeOf(plan)]);
    expect(await read('.codex', 'config.toml')).toBe(
      `${before}\n[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "codex"]\n`,
    );
  });

  it('a new Codex file is created with only the table', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    await init(['--confirm', codeOf(plan)]);
    expect(await read('.codex', 'config.toml')).toBe(
      '[mcp_servers.agentlink]\ncommand = "npx"\nargs = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "codex"]\n',
    );
    expect(await exists('.codex', 'config.toml')).toBe(true);
  });

  it('a non-default agent adds --agent to the entry, and no secret is ever in a config', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init(['--agent', 'work-1']);
    expect(plan.out).toContain(
      'args = ["-y", "@4thtech-io/agentlink", "mcp", "--agent", "work-1"]',
    );
    expect(plan.out).toContain('agentlink init --agent work-1 --confirm');
    await init(['--agent', 'work-1', '--confirm', codeOf(plan)]);
    const text = await read('.codex', 'config.toml');
    expect(text).not.toMatch(/PASSPHRASE|0x[0-9a-f]{40}|token|secret/i);
    expect((await readAgentConfig(home, 'work-1'))?.config.name).toBe('work-1');
  });
});

describe('confirmation', () => {
  it('without a TTY prints the diff and a code and writes nothing', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toContain(copy('cli.init.agentConfirm', { code: codeOf(run) }));
    expect(run.created).toBe(0);
    expect(await exists('.codex', 'config.toml')).toBe(false);
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
    expect(await names()).toEqual(['.codex']);
  });

  it('with a harness marker set it is treated as agent-run even on a terminal', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: AGENT_RUN, answers: ['y', 'y'] });
    expect(run.asked).toBe(0);
    expect(run.out).toContain('--confirm');
    expect(await exists('.codex', 'config.toml')).toBe(false);
  });

  it('refuses a wrong code, a malformed code and a code for other changes, writing nothing', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    const wrong = await init(['--confirm', '0000-0000']);
    expect(wrong.code).toBe(EXIT_FAILED);
    expect(wrong.err).toBe(withPrefix(INIT_TEXT.codeMismatch));
    const malformed = await init(['--confirm', 'not a code']);
    expect(malformed.code).toBe(EXIT_USAGE);
    expect(malformed.err).toBe(withPrefix(INIT_TEXT.badCode));
    expect(malformed.err).not.toContain('not a code');
    // A code made for one agent name does not work for another.
    const other = await init(['--agent', 'other', '--confirm', codeOf(plan)]);
    expect(other.code).toBe(EXIT_FAILED);
    expect(await exists('.codex', 'config.toml')).toBe(false);
    expect(wrong.created + malformed.created + other.created).toBe(0);
  });

  it('a code stops working when the file changed after it was shown', async () => {
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), 'a = 1\n');
    const plan = await init([]);
    await writeFile(join(home, '.codex', 'config.toml'), 'a = 2\n');
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(await read('.codex', 'config.toml')).toBe('a = 2\n');
  });

  it('a used code does not match again (nothing left to change)', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect((await init(['--confirm', codeOf(plan)])).code).toBe(EXIT_OK);
    const again = await init(['--confirm', codeOf(plan)]);
    expect(again.out).toContain(INIT_TEXT.nothingToDo);
    expect((await read('.codex', 'config.toml')).match(/\[mcp_servers\.agentlink\]/g)).toHaveLength(
      1,
    );
  });

  it('in a terminal, asks per harness and writes only what is confirmed', async () => {
    await mkdir(join(home, '.codex'));
    const env = await geminiOnPath();
    const run = await init([], { terminal: { ...TTY, env }, answers: ['y', 'n'] });
    expect(run.asked).toBe(2);
    expect(run.out).toContain(copy('cli.init.apply'));
    expect(await exists('.codex', 'config.toml')).toBe(true);
    expect(await exists('.gemini', 'settings.json')).toBe(false);
    expect(run.created).toBe(1);
  });

  it('in a terminal, names the app in front of each question (IR-M1-9a-1 F07)', async () => {
    await mkdir(join(home, '.codex'));
    const env = await geminiOnPath();
    const run = await init([], { terminal: { ...TTY, env }, answers: ['y', 'n'] });
    const lines = run.out.split('\n');
    const questions = lines.flatMap((l, i) => (l === copy('cli.init.apply') ? [i] : []));
    expect(questions).toHaveLength(2);
    // M1-36b (UX-B F9): the header, then that app's diff, then its question.
    const headerAbove = (q: number): string | undefined =>
      lines
        .slice(0, q)
        .reverse()
        .find((l) => l.startsWith('Changes for '));
    expect(headerAbove(questions[0] ?? 0)).toBe(copy('cli.init.changesFor', { appName: 'Codex' }));
    expect(headerAbove(questions[1] ?? 0)).toBe(
      copy('cli.init.changesFor', { appName: 'Gemini CLI' }),
    );
  });

  it('does not write to ~/.claude.json when CLAUDE_CONFIG_DIR moves Claude Code elsewhere (F05)', async () => {
    await writeFile(join(home, '.claude.json'), CLAUDE_JSON, { mode: 0o600 });
    const plan = await init([], { terminal: { ...PIPE, env: { CLAUDE_CONFIG_DIR: outside } } });
    expect(plan.err).toContain("Claude Code's settings");
    expect(plan.out).not.toContain('--- a/~/.claude.json');
  });

  // D-78 (06 §7): declining every proposed change writes no harness config but keeps the agent
  // identity (before M1-9t, declining everything also cancelled the identity).
  it('in a terminal, declining every harness change writes no config but keeps the identity', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], { terminal: TTY, answers: ['', 'maybe'] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.out).toContain(withPrefix(INIT_TEXT.declinedKept));
    expect(run.created).toBe(1);
    expect(await exists('.codex', 'config.toml')).toBe(false);
    // M1-36b (D5): the one app found names the agent.
    expect((await readAgentConfig(home, 'codex'))?.config.agentId).toBe(AGENT_ID);
  });

  it('declining every change never touches an existing identity', async () => {
    await mkdir(join(home, '.codex'));
    const first = await init(['--harness', 'none']);
    await init(['--harness', 'none', '--confirm', codeOf(first)]);
    const run = await init([], { terminal: TTY, answers: ['n'] });
    expect(run.created).toBe(0);
    expect(run.code).toBe(EXIT_OK);
    expect((await readAgentConfig(home, 'default'))?.config.agentId).toBe(AGENT_ID);
    expect(await exists('.codex', 'config.toml')).toBe(false);
  });

  it('never prints or asks for an owner secret, and points to `owner init`', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.out).toContain('agentlink owner init');
    expect(`${plan.out}${run.out}`).not.toMatch(/passphrase|owner code:/i);
  });
});

describe('an existing agent', () => {
  it('is reused, never replaced, so init can add another harness later', async () => {
    await mkdir(join(home, '.codex'));
    const first = await init([]);
    await init(['--confirm', codeOf(first)]);
    const env = await geminiOnPath();
    const second = await init([], { terminal: { ...PIPE, env } });
    expect(second.out).not.toContain(INIT_TEXT.identity);
    await init(['--confirm', codeOf(second)], { terminal: { ...PIPE, env } });
    // M1-36b (D5): the first run named the agent after Codex; the second run reuses it.
    expect((await readAgentConfig(home, 'codex'))?.config.agentId).toBe(AGENT_ID);
    expect(await readAgentConfig(home, 'default')).toBeUndefined();
    expect(await exists('.gemini', 'settings.json')).toBe(true);
  });
});

describe('malformed or unusable configs', () => {
  it('an invalid JSON config is reported, never written, and others still proceed', async () => {
    await writeFile(join(home, '.claude.json'), '{ "mcpServers": ');
    await mkdir(join(home, '.codex'));
    const plan = await init([]);
    expect(plan.err).toContain("Claude Code's settings file isn't valid");
    expect(plan.out).not.toContain('--- a/~/.claude.json');
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(await read('.claude.json')).toBe('{ "mcpServers": ');
    expect(await names()).not.toContain(`.claude.json.agentlink-backup-${NOW}`);
    expect(await exists('.codex', 'config.toml')).toBe(true);
  });

  it('an invalid TOML config is reported and never written', async () => {
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), 'model = "unterminated\n');
    const plan = await init([]);
    expect(plan.err).toContain("Codex's settings file isn't valid");
    expect(plan.code).toBe(EXIT_OK);
    const run = await init(['--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(await read('.codex', 'config.toml')).toBe('model = "unterminated\n');
    expect(await readdir(join(home, '.codex'))).toEqual(['config.toml']);
  });

  it('only malformed configs and no agent to create exits with a failure and writes nothing', async () => {
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'config.toml'), 'x = [\n');
    const first = await init([]);
    await init(['--confirm', codeOf(first)]);
    const again = await init([]);
    expect(again.code).toBe(EXIT_FAILED);
    expect(await read('.codex', 'config.toml')).toBe('x = [\n');
  });

  it('a different existing agentlink entry is left as it is', async () => {
    await mkdir(join(home, '.codex'));
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.agentlink]\ncommand = "mine"\n',
    );
    const plan = await init([]);
    expect(plan.out).toContain('Codex already has an entry named agentlink');
    const run = await init(['--confirm', codeOf(plan)]);
    expect(await read('.codex', 'config.toml')).toBe('[mcp_servers.agentlink]\ncommand = "mine"\n');
    expect(run.code).toBe(EXIT_OK);
  });

  it.skipIf(!POSIX)(
    'a symlinked config is refused, and nothing is written through it',
    async () => {
      await writeFile(join(outside, 'real.toml'), 'a = 1\n');
      await mkdir(join(home, '.codex'));
      await symlink(join(outside, 'real.toml'), join(home, '.codex', 'config.toml'));
      const plan = await init([]);
      expect(plan.err).toContain("Codex's settings are in a place AgentLink won't write to");
      await init(['--confirm', codeOf(plan)]);
      expect(await readFile(join(outside, 'real.toml'), 'utf8')).toBe('a = 1\n');
    },
  );

  it.skipIf(!POSIX)('a symlinked harness folder pointing outside home is refused', async () => {
    await symlink(outside, join(home, '.gemini'));
    const plan = await init(['--harness', 'gemini-cli']);
    expect(plan.err).toContain("Gemini CLI's settings are in a place AgentLink won't write to");
    expect(plan.code).toBe(EXIT_FAILED);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('keychain and agent names', () => {
  it('without a keychain answers needs_setup with the 07 §9.4 copy and writes nothing', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init([], {
      probe: { ok: false, reason: 'unavailable', fix: 'security unlock-keychain' },
    });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toContain(NO_KEYCHAIN_COPY);
    expect(run.created).toBe(0);
    expect(await names()).toEqual(['.codex']);
    const confirmed = await init(['--confirm', '0000-0000'], {
      probe: { ok: false, reason: 'unavailable', fix: 'fix it' },
    });
    expect(confirmed.err).toContain(NO_KEYCHAIN_COPY);
    expect(await names()).toEqual(['.codex']);
  });

  it.each([
    ['upper case', 'Work'],
    ['a leading dash', '-x'],
    ['a leading digit', '1a'],
    ['too long', 'a'.repeat(33)],
    ['a trailing newline', 'work\n'],
    ['a path', '../x'],
    ['a space', 'a b'],
    ['empty', ''],
  ])('refuses an agent name with %s, with fixed text and no write', async (_label, name) => {
    await mkdir(join(home, '.codex'));
    const run = await init([`--agent=${name}`]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).toBe(RUNTIME_MESSAGES.agent_name_invalid);
    expect(run.err).not.toContain(name === '' ? 'never matches' : name);
    expect(run.created).toBe(0);
    expect(await names()).toEqual(['.codex']);
  });

  it('refuses an invalid agent name when the handler is called without the dispatcher', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const handler = createInitHandler({
      home,
      probeKeychain: () => Promise.resolve({ ok: true }),
      createAgent: () => Promise.reject(new Error('must not be called')),
      readLine: () => Promise.resolve(''),
      clock: () => NOW,
    });
    const code = await handler({
      command: 'init',
      parsed: { values: {}, positionals: [], agent: 'Bad Name\n' },
      output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
      terminal: PIPE,
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual([RUNTIME_MESSAGES.agent_name_invalid]);
    expect(await names()).toEqual([]);
  });

  it('accepts the longest valid name and the default name', async () => {
    const long = `a${'b'.repeat(31)}`;
    const plan = await init(['--agent', long]);
    expect(plan.code).toBe(EXIT_OK);
    const run = await init(['--agent', long, '--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_OK);
    expect((await readAgentConfig(home, long))?.config.name).toBe(long);
  });

  it('refuses extra arguments with fixed text', async () => {
    const run = await init(['whatever']);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).not.toContain('whatever');
  });
});

// D-78 (06 §7): one harness at a time, identity only, OpenCode and Antigravity, `--config`.
describe('init --harness and --config (M1-9t)', () => {
  // M1-36b (D5): one app, so the agent is named after it.
  const OPENCODE_ENTRY = {
    type: 'local',
    command: ['npx', '-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'opencode'],
    enabled: true,
  };
  const ANTIGRAVITY_ENTRY = {
    command: 'npx',
    args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'antigravity'],
  };
  const readAbs = (path: string): Promise<string> => readFile(path, 'utf8');
  const existsAbs = (path: string): Promise<boolean> =>
    readFile(path).then(
      () => true,
      () => false,
    );

  it('--harness <id> proposes and writes that harness only', async () => {
    await mkdir(join(home, '.codex'));
    await mkdir(join(home, '.gemini'));
    const plan = await init(['--harness', 'codex']);
    expect(plan.out).toContain('--- a/~/.codex/config.toml');
    expect(plan.out).not.toContain('settings.json');
    expect(plan.out).toContain('agentlink init --agent codex --harness codex --confirm');
    const run = await init(['--harness', 'codex', '--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_OK);
    expect(await exists('.codex', 'config.toml')).toBe(true);
    expect(await exists('.gemini', 'settings.json')).toBe(false);
  });

  it('a code for one harness does not confirm another', async () => {
    await mkdir(join(home, '.codex'));
    await mkdir(join(home, '.gemini'));
    const plan = await init(['--harness', 'codex']);
    const run = await init(['--harness', 'gemini-cli', '--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(await exists('.gemini', 'settings.json')).toBe(false);
    expect(run.created).toBe(0);
  });

  it('--harness none creates the identity only, even with harnesses detected', async () => {
    await mkdir(join(home, '.codex'));
    const plan = await init(['--harness', 'none']);
    expect(plan.out).not.toContain('config.toml');
    expect(plan.out).toContain(INIT_TEXT.identity);
    const run = await init(['--harness', 'none', '--confirm', codeOf(plan)]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.created).toBe(1);
    expect(await exists('.codex', 'config.toml')).toBe(false);
  });

  it('--harness none in a terminal creates the identity without asking about any app', async () => {
    await mkdir(join(home, '.codex'));
    const run = await init(['--harness', 'none'], { terminal: TTY });
    expect(run.asked).toBe(0);
    expect(run.created).toBe(1);
    expect(await exists('.codex', 'config.toml')).toBe(false);
  });

  it('refuses an unknown harness with fixed text', async () => {
    const run = await init(['--harness', 'vim-ide']);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).not.toContain('vim-ide');
    expect(run.created).toBe(0);
  });

  it('OpenCode: ~/.config/opencode/opencode.json gets mcp.agentlink, type local, one command array', async () => {
    const plan = await init(['--harness', 'opencode']);
    expect(plan.out).toContain('--- a/~/.config/opencode/opencode.json');
    await init(['--harness', 'opencode', '--confirm', codeOf(plan)]);
    expect(JSON.parse(await read('.config', 'opencode', 'opencode.json'))).toEqual({
      mcp: { agentlink: OPENCODE_ENTRY },
    });
  });

  it('OpenCode: keeps the other settings and servers of an existing file', async () => {
    await mkdir(join(home, '.config', 'opencode'), { recursive: true, mode: 0o700 });
    const before = `${JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', mcp: { other: { type: 'remote', url: 'x' } } },
      null,
      2,
    )}\n`;
    await writeFile(join(home, '.config', 'opencode', 'opencode.json'), before, { mode: 0o600 });
    const plan = await init(['--harness', 'opencode']);
    await init(['--harness', 'opencode', '--confirm', codeOf(plan)]);
    expect(JSON.parse(await read('.config', 'opencode', 'opencode.json'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { agentlink: OPENCODE_ENTRY, other: { type: 'remote', url: 'x' } },
    });
  });

  it('OpenCode: a named agent ends the command array with --agent <name>', async () => {
    const plan = await init(['--agent', 'open-1', '--harness', 'opencode']);
    await init(['--agent', 'open-1', '--harness', 'opencode', '--confirm', codeOf(plan)]);
    const written = JSON.parse(await read('.config', 'opencode', 'opencode.json'));
    expect(written.mcp.agentlink.command).toEqual([
      'npx',
      '-y',
      '@4thtech-io/agentlink',
      'mcp',
      '--agent',
      'open-1',
    ]);
  });

  it('Antigravity: ~/.gemini/config/mcp_config.json gets mcpServers.agentlink, not the Gemini CLI file', async () => {
    await mkdir(join(home, '.gemini'), { mode: 0o700 });
    const plan = await init(['--harness', 'antigravity']);
    expect(plan.out).toContain('--- a/~/.gemini/config/mcp_config.json');
    await init(['--harness', 'antigravity', '--confirm', codeOf(plan)]);
    expect(JSON.parse(await read('.gemini', 'config', 'mcp_config.json'))).toEqual({
      mcpServers: { agentlink: ANTIGRAVITY_ENTRY },
    });
    expect(await exists('.gemini', 'settings.json')).toBe(false);
  });

  it('detects OpenCode by its config folder when no --harness is given', async () => {
    await mkdir(join(home, '.config', 'opencode'), { recursive: true, mode: 0o700 });
    const plan = await init([]);
    expect(plan.out).toContain('OpenCode');
  });

  it('--config writes the exact file the owner named for Antigravity', async () => {
    const target = join(outside, 'mcp_config.json');
    const plan = await init(['--harness', 'antigravity', '--config', target]);
    expect(plan.code).toBe(EXIT_OK);
    const run = await init([
      '--harness',
      'antigravity',
      '--config',
      target,
      '--confirm',
      codeOf(plan),
    ]);
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(await readAbs(target))).toEqual({
      mcpServers: { agentlink: ANTIGRAVITY_ENTRY },
    });
    expect(await exists('.gemini', 'config', 'mcp_config.json')).toBe(false);
  });

  it('a code for one --config path does not confirm another', async () => {
    const one = join(outside, 'one.json');
    const two = join(outside, 'two.json');
    const plan = await init(['--harness', 'antigravity', '--config', one]);
    const run = await init([
      '--harness',
      'antigravity',
      '--config',
      two,
      '--confirm',
      codeOf(plan),
    ]);
    expect(run.code).toBe(EXIT_FAILED);
    expect(await existsAbs(two)).toBe(false);
  });

  it('refuses --config without --harness, or with a harness other than OpenCode or Antigravity', async () => {
    const target = join(outside, 'x.json');
    for (const argv of [
      ['--config', target],
      ['--harness', 'codex', '--config', target],
      ['--harness', 'none', '--config', target],
    ]) {
      const run = await init(argv);
      expect(run.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(run.err).not.toContain(target);
    }
    expect(await existsAbs(target)).toBe(false);
  });

  it.skipIf(!POSIX)(
    'refuses a --config file that is a symbolic link, and leaves its target alone',
    async () => {
      const real = join(outside, 'real.json');
      await writeFile(real, '{}\n', { mode: 0o600 });
      const linked = join(outside, 'linked.json');
      await symlink(real, linked);
      const plan = await init(['--harness', 'antigravity', '--config', linked]);
      expect(plan.code).toBe(EXIT_FAILED);
      expect(plan.out).not.toContain('--confirm');
      expect(await readAbs(real)).toBe('{}\n');
    },
  );

  it('refuses a --config path under ~/.agentlink or ~/.ssh, or whose folder does not exist', async () => {
    await mkdir(join(home, '.agentlink'), { recursive: true, mode: 0o700 });
    await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 });
    for (const target of [
      join(home, '.agentlink', 'mcp_config.json'),
      join(home, '.ssh', 'mcp_config.json'),
      join(outside, 'missing', 'mcp_config.json'),
    ]) {
      const plan = await init(['--harness', 'antigravity', '--config', target]);
      expect(plan.code, target).toBe(EXIT_FAILED);
      expect(plan.out).not.toContain('--confirm');
    }
    expect(await exists('.agentlink', 'mcp_config.json')).toBe(false);
  });

  it.skipIf(!POSIX)(
    'refuses a --config path in the real folder behind a linked ~/.agentlink (IR-M1-9t-1 L-1)',
    async () => {
      const real = join(outside, 'agentlink-data');
      await mkdir(real, { mode: 0o700 });
      await symlink(real, join(home, '.agentlink'));
      const target = join(real, 'mcp_config.json');
      const plan = await init(['--harness', 'antigravity', '--config', target]);
      expect(plan.code).toBe(EXIT_FAILED);
      expect(plan.out).not.toContain('--confirm');
      expect(await existsAbs(target)).toBe(false);
    },
  );

  it('refuses a --config file that is not a .json file', async () => {
    const plan = await init(['--harness', 'opencode', '--config', join(outside, 'opencode.toml')]);
    expect(plan.code).not.toBe(EXIT_OK);
    expect(plan.out).not.toContain('--confirm');
  });
});

describe('apps lists name every harness (M1-36g-b)', () => {
  it('appsAll names every app in the harness table, appsLinux all but Claude Desktop', () => {
    for (const def of HARNESSES) {
      expect(INIT_TEXT.appsAll).toContain(def.appName);
      if (def.id === 'claude-desktop') expect(INIT_TEXT.appsLinux).not.toContain(def.appName);
      else expect(INIT_TEXT.appsLinux).toContain(def.appName);
    }
  });
});

describe('Windsurf: the code binds the path that is written (M1-36g-c)', () => {
  const xdgEnv = (): Record<string, string> => ({ XDG_CONFIG_HOME: join(home, 'xdg') });
  const XDG_FILE = ['xdg', 'devin', 'mcp_config.json'] as const;
  const DEFAULT_FILE = ['.config', 'devin', 'mcp_config.json'] as const;

  it('with XDG_CONFIG_HOME set, shows that path and writes exactly there on confirmation', async () => {
    const terminal = { ...PIPE, env: xdgEnv() };
    const plan = await init(['--harness', 'windsurf'], { platform: 'linux', terminal });
    expect(plan.code).toBe(EXIT_OK);
    expect(plan.out).toContain('~/xdg/devin/mcp_config.json');
    expect(plan.out).not.toContain('~/.config/devin/mcp_config.json');
    expect(await exists(...XDG_FILE)).toBe(false);
    const run = await init(['--harness', 'windsurf', '--confirm', codeOf(plan)], {
      platform: 'linux',
      terminal,
    });
    expect(run.code).toBe(EXIT_OK);
    expect(JSON.parse(await read(...XDG_FILE))).toMatchObject({
      mcpServers: { agentlink: { command: 'npx' } },
    });
    expect(await exists(...DEFAULT_FILE)).toBe(false);
  });

  it('gives a different code with and without XDG_CONFIG_HOME', async () => {
    const withXdg = await init(['--harness', 'windsurf'], {
      platform: 'linux',
      terminal: { ...PIPE, env: xdgEnv() },
    });
    const without = await init(['--harness', 'windsurf'], { platform: 'linux' });
    expect(without.out).toContain('~/.config/devin/mcp_config.json');
    expect(codeOf(withXdg)).not.toBe(codeOf(without));
  });

  it('a code shown with one environment does not confirm under another; nothing is written', async () => {
    const plan = await init(['--harness', 'windsurf'], {
      platform: 'linux',
      terminal: { ...PIPE, env: xdgEnv() },
    });
    const moved = await init(['--harness', 'windsurf', '--confirm', codeOf(plan)], {
      platform: 'linux',
    });
    expect(moved.code).toBe(EXIT_FAILED);
    expect(moved.err).toContain(withPrefix(INIT_TEXT.codeMismatch));
    expect(moved.created).toBe(0);
    expect(await exists(...XDG_FILE)).toBe(false);
    expect(await exists(...DEFAULT_FILE)).toBe(false);

    const back = await init(['--harness', 'windsurf'], { platform: 'linux' });
    const reverse = await init(['--harness', 'windsurf', '--confirm', codeOf(back)], {
      platform: 'linux',
      terminal: { ...PIPE, env: xdgEnv() },
    });
    expect(reverse.code).toBe(EXIT_FAILED);
    expect(await exists(...XDG_FILE)).toBe(false);
    expect(await exists(...DEFAULT_FILE)).toBe(false);
  });
});
