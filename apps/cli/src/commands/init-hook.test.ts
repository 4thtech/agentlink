// `agentlink init --hook` (M1-29; 06 §7, §8, D-53): the optional SessionStart hook for Claude Code.
// A separate opt-in with the same exact-diff-and-confirm step as the MCP entry; never written
// silently; a malformed config aborts with no write; no `npx` in what is written.
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  createDispatcher,
  type DispatchIO,
} from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { createInitHandler, type InitDeps } from './init.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const AGENT_RUN: TerminalContext = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  env: { CLAUDECODE: '1' },
};
const PREFIX = '"/opt/node/bin/node" "/opt/agentlink/dist/agentlink.js"';
const COMMAND = `${PREFIX} status --brief`;
/** How the command appears inside the JSON text of the settings file and the diff. */
const ESCAPED = COMMAND.replaceAll('"', '\\"');

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-hook-')));
  await mkdir(join(home, '.claude'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

interface Run {
  code: number;
  out: string;
  err: string;
  created: number;
  asked: number;
}

async function run(
  argv: readonly string[],
  options: {
    terminal?: TerminalContext;
    answers?: string[];
    installedCli?: string | undefined;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let created = 0;
  let asked = 0;
  const answers = [...(options.answers ?? [])];
  const installedCli = 'installedCli' in options ? options.installedCli : PREFIX;
  const deps: InitDeps = {
    home,
    probeKeychain: () => Promise.resolve({ ok: true }),
    createAgent: () => {
      created += 1;
      return Promise.resolve(`0x${'ab'.repeat(20)}`);
    },
    readLine: () => {
      asked += 1;
      return Promise.resolve(answers.shift() ?? '');
    },
    clock: () => 1_800_000_000,
    installedCli: () => Promise.resolve(installedCli),
  };
  const dispatch = createDispatcher({ init: createInitHandler(deps) });
  const io: DispatchIO = {
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal: options.terminal ?? TTY,
    version: '0.0.0',
  };
  const code = await dispatch(['init', ...argv], io);
  return { code, out: out.join('\n'), err: err.join('\n'), created, asked };
}

const settings = (): string => join(home, '.claude', 'settings.json');
const readSettings = (): Promise<string> => readFile(settings(), 'utf8');
const exists = (): Promise<boolean> =>
  readFile(settings()).then(
    () => true,
    () => false,
  );
const codeOf = (r: Run): string => {
  const m = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(r.out);
  if (m?.[1] === undefined) throw new Error('no code');
  return m[1];
};

describe('init --hook', () => {
  it('shows the exact diff and writes nothing when the answer is no', async () => {
    const r = await run(['--hook'], { answers: ['n'] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('SessionStart');
    expect(r.out).toContain(ESCAPED);
    expect(await exists()).toBe(false);
  });

  it('writes the hook after a yes, without creating an identity or touching the MCP entry', async () => {
    const r = await run(['--hook'], { answers: ['y'] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.created).toBe(0);
    const written = JSON.parse(await readSettings()) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(written.hooks.SessionStart[0]?.hooks[0]?.command).toBe(COMMAND);
    expect(await readSettings()).not.toContain('npx');
    expect(await readdir(home)).not.toContain('.claude.json');
  });

  it('keeps the existing settings and backs the old file up', async () => {
    await writeFile(settings(), `${JSON.stringify({ model: 'x' }, null, 2)}\n`);
    const r = await run(['--hook'], { answers: ['y'] });
    expect(r.code).toBe(EXIT_OK);
    expect((JSON.parse(await readSettings()) as { model: string }).model).toBe('x');
    expect((await readdir(join(home, '.claude'))).length).toBeGreaterThan(1);
  });

  it('run by an agent: prints the diff and a code, writes nothing; --confirm then writes', async () => {
    const first = await run(['--hook'], { terminal: AGENT_RUN });
    expect(first.code).toBe(EXIT_OK);
    expect(await exists()).toBe(false);
    const code = codeOf(first);
    expect(first.out).toContain('--hook');
    const wrong = await run(['--hook', '--confirm', '0000-0000'], { terminal: AGENT_RUN });
    expect(wrong.code).toBe(EXIT_FAILED);
    expect(await exists()).toBe(false);
    const done = await run(['--hook', '--confirm', code], { terminal: AGENT_RUN });
    expect(done.code).toBe(EXIT_OK);
    expect(await readSettings()).toContain(ESCAPED);
  });

  it('a code from the MCP entry diff does not confirm the hook', async () => {
    const mcp = await run([], { terminal: AGENT_RUN });
    const wrong = await run(['--hook', '--confirm', codeOf(mcp)], { terminal: AGENT_RUN });
    expect(wrong.code).toBe(EXIT_FAILED);
    expect(await exists()).toBe(false);
  });

  it('is already done on a second run', async () => {
    await run(['--hook'], { answers: ['y'] });
    const before = await readSettings();
    const again = await run(['--hook'], { answers: ['y'] });
    expect(again.code).toBe(EXIT_OK);
    expect(again.asked).toBe(0);
    expect(await readSettings()).toBe(before);
  });

  it('aborts with no write on a malformed settings file', async () => {
    await writeFile(settings(), '{ broken');
    const r = await run(['--hook'], { answers: ['y'] });
    expect(r.code).toBe(EXIT_FAILED);
    expect(await readSettings()).toBe('{ broken');
    expect(r.asked).toBe(0);
  });

  it('refuses when there is no installed binary to point at (npx copy)', async () => {
    const r = await run(['--hook'], { answers: ['y'], installedCli: undefined });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.err).toContain('npm install -g');
    expect(await exists()).toBe(false);
  });

  it('adds --agent for a named agent', async () => {
    const r = await run(['--hook', '--agent', 'work'], { answers: ['y'] });
    expect(r.code).toBe(EXIT_OK);
    expect(await readSettings()).toContain('status --brief --agent work');
  });

  it('accepts only Claude Code, and no --config', async () => {
    expect((await run(['--hook', '--harness', 'codex'])).code).toBe(EXIT_USAGE);
    expect((await run(['--hook', '--harness', 'none'])).code).toBe(EXIT_USAGE);
    expect((await run(['--hook', '--harness', 'opencode', '--config', '/x.json'])).code).toBe(
      EXIT_USAGE,
    );
    expect((await run(['--hook', '--harness', 'claude-code'], { answers: ['y'] })).code).toBe(
      EXIT_OK,
    );
  });

  it('plain init never touches the hook', async () => {
    await run([], { terminal: AGENT_RUN });
    expect(await exists()).toBe(false);
  });
});
