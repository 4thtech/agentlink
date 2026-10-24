// M1-11b-6: `init` calls the first-run step (first-run.ts) once it is done: after a fresh setup with
// no other agent on this computer, and on a re-run with nothing left to change. The step gets whether
// this is the owner's own interactive run (never with `--confirm`); when it reports the owner step
// handled, the `agentlink owner init` line is not printed. Kept apart from init.test.ts.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, createDispatcher, type DispatchIO } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { INIT_TEXT, createInitHandler, type InitDeps } from './init.js';

const AGENT_ID = `0x${'ab'.repeat(20)}`;
const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-init-first-run-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Call {
  readonly name: string;
  readonly interactive: boolean;
  readonly prefix: string;
}

/** The command as this run was started (M1-36a `cliPrefix`); not on PATH. */
const NPX = 'npx -y @4thtech-io/agentlink';

interface Install {
  /** The offered global install succeeds or fails; undefined: never offered. */
  readonly succeeds?: boolean;
}

async function init(
  argv: readonly string[],
  terminal: TerminalContext,
  handled: boolean,
  install: Install = {},
): Promise<{ code: number; out: string; calls: Call[] }> {
  const out: string[] = [];
  const calls: Call[] = [];
  let onPath = false;
  const deps: InitDeps = {
    home,
    probeKeychain: () => Promise.resolve({ ok: true }),
    createAgent: () => Promise.resolve(AGENT_ID),
    // The install question (when offered) is answered yes.
    readLine: () => Promise.resolve(install.succeeds === undefined ? '' : 'y'),
    cliPrefix: () => NPX,
    ...(install.succeeds === undefined
      ? {}
      : {
          agentlinkOnPath: () => onPath,
          installGlobal: () => {
            onPath = install.succeeds === true;
            return Promise.resolve(onPath);
          },
        }),
    clock: () => 1_800_000_000,
    firstRun: (_context, name, interactive, prefix) => {
      calls.push({ name, interactive, prefix });
      return Promise.resolve(handled);
    },
  };
  const io: DispatchIO = {
    output: { print: (t) => out.push(t), printError: (t) => out.push(t) },
    terminal,
    version: '0.0.0',
  };
  const code = await createDispatcher({ init: createInitHandler(deps) })(['init', ...argv], io);
  return { code, out: out.join('\n'), calls };
}

describe('init and the first-run page (M1-11b-6)', () => {
  it('in the owner terminal, a fresh setup hands over to the first-run page', async () => {
    const run = await init(['--harness', 'none'], TTY, true);
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([{ name: 'default', interactive: true, prefix: NPX }]);
    // Handled by the page: no `agentlink owner init` line.
    expect(run.out).not.toContain(' owner init');
  });

  it('when the step did not handle it, the terminal way is printed as before', async () => {
    const run = await init(['--harness', 'none'], TTY, false);
    expect(run.calls).toEqual([{ name: 'default', interactive: true, prefix: NPX }]);
    expect(run.out).toContain(' owner init');
  });

  it('an agent run with --confirm is never interactive', async () => {
    const first = await init(['--harness', 'none'], PIPE, false);
    // Showing the code writes nothing and never reaches the step.
    expect(first.calls).toEqual([]);
    const code = /--confirm ([0-9a-f]{4}-[0-9a-f]{4})/.exec(first.out)?.[1] ?? '';
    const run = await init(['--harness', 'none', '--confirm', code], TTY, false);
    expect(run.calls).toEqual([{ name: 'default', interactive: false, prefix: NPX }]);
  });

  it('a re-run with nothing to change still offers the page', async () => {
    await init(['--harness', 'none'], TTY, false);
    const run = await init(['--harness', 'none'], TTY, false);
    expect(run.out).toContain(INIT_TEXT.nothingToDo);
    expect(run.calls).toEqual([{ name: 'default', interactive: true, prefix: NPX }]);
  });

  it('M1-36b: the step runs after the install offer and gets the command that now works', async () => {
    const fresh = await init(['--harness', 'none'], TTY, false, { succeeds: true });
    expect(fresh.calls).toEqual([{ name: 'default', interactive: true, prefix: 'agentlink' }]);
    const again = await init(['--harness', 'none'], TTY, false, { succeeds: true });
    expect(again.out).toContain(INIT_TEXT.nothingToDo);
    expect(again.calls).toEqual([{ name: 'default', interactive: true, prefix: 'agentlink' }]);
  });
});
