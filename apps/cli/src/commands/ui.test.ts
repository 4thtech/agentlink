// M1-11b-9: `agentlink ui` opens the local app on demand (08 §1; 04 §2.5).
//
// - In the owner's own interactive terminal: the approval server starts, the OS browser opens the
//   one-shot session link at Home (U3-a, D-138), or at the first-run page while no owner exists. The
//   command serves until Ctrl+C or a time limit. The link is never printed or logged.
// - Run by an agent (no TTY, or a harness marker): one fixed line telling the user to run the command
//   themselves, built with the CLI prefix; no agent is opened, no server, no browser.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { UI_TEXT, UI_WAIT_MS, openUiPage, uiStep, type UiDeps, type UiPage } from './ui.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const AGENT: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
const PREFIX = 'npx -y @4thtech-io/agentlink';

function probe(terminal: TerminalContext, agent?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const context: CommandContext = {
    command: 'ui',
    parsed: { values: {}, positionals: [], agent },
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal,
  };
  return { out, err, context };
}

interface Script {
  readonly page?: UiPage;
  readonly start?: 'none' | 'throws';
  readonly opens?: boolean | 'throws';
  readonly stop?: 'soon' | 'never';
  readonly waitMs?: number;
  /** M1-UX-MULTI-AGENT: the local agent names on this computer. */
  readonly agents?: readonly string[];
  readonly answers?: readonly string[];
}

function fakeDeps(script: Script) {
  const calls = {
    start: 0,
    opened: 0,
    closed: 0,
    unsubscribed: 0,
    names: [] as (string | undefined)[],
  };
  const answers = [...(script.answers ?? [])];
  let stop: (() => void) | undefined;
  const deps: UiDeps = {
    ...(script.agents === undefined
      ? {}
      : {
          agents: () => Promise.resolve(script.agents ?? []),
          readLine: () => Promise.resolve(answers.shift() ?? ''),
        }),
    start: (name) => {
      calls.start += 1;
      calls.names.push(name);
      if (script.start === 'throws') return Promise.reject(new Error('keychain locked'));
      if (script.start === 'none') return Promise.resolve(undefined);
      return Promise.resolve({
        page: script.page ?? 'home',
        open: () => {
          calls.opened += 1;
          if (script.opens === 'throws') return Promise.reject(new Error('opener'));
          const opened = script.opens ?? true;
          if (opened && (script.stop ?? 'soon') === 'soon') setTimeout(() => stop?.(), 5);
          return Promise.resolve(opened);
        },
        close: () => {
          calls.closed += 1;
          return Promise.resolve();
        },
      });
    },
    waitMs: script.waitMs ?? 5_000,
    interrupt: (handler) => {
      stop = handler;
      return () => {
        calls.unsubscribed += 1;
        stop = undefined;
      };
    },
  };
  return { deps, calls };
}

function expectNoLink(p: { out: string[]; err: string[] }): void {
  const all = [...p.out, ...p.err].join('\n');
  expect(all).not.toMatch(/https?:\/\//);
  expect(all).not.toContain('?t=');
  expect(all).not.toContain('localhost');
}

describe('agentlink ui in the owner terminal (M1-11b-9)', () => {
  it.each(['home', 'first-run'] as const)(
    'opens the %s page, serves until Ctrl+C, then closes',
    async (page) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ page });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
      expect(calls).toMatchObject({ start: 1, opened: 1, closed: 1 });
      expect(calls.unsubscribed).toBeGreaterThan(0);
      expect(p.out).toEqual([page === 'home' ? UI_TEXT.opened : UI_TEXT.openedSetup]);
      expect(p.err).toEqual([]);
      expectNoLink(p);
    },
  );

  it('stops after the time limit', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ stop: 'never', waitMs: 30 });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.closed).toBe(1);
  });

  it('the limit is 30 minutes', () => {
    expect(UI_WAIT_MS).toBe(30 * 60_000);
  });

  it.each(['none', 'throws'] as const)(
    'an agent that is not set up or a server that cannot start (%s): the fixed init line, exit 1',
    async (start) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ start });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
      expect(calls).toMatchObject({ opened: 0 });
      expect(p.err).toEqual([UI_TEXT.notReady(PREFIX)]);
      expectNoLink(p);
    },
  );

  it.each([false, 'throws'] as const)(
    'no browser (%s): closes at once, says so, never shows the link',
    async (opens) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ opens });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
      expect(calls).toMatchObject({ opened: 1, closed: 1 });
      expect(p.err).toEqual([UI_TEXT.noBrowser]);
      expectNoLink(p);
    },
  );
});

describe('agentlink ui run by an agent (M1-11b-9)', () => {
  it.each([
    ['a harness marker', AGENT],
    ['no terminal', PIPE],
  ] as const)('with %s: one fixed line, nothing else happens', async (_label, terminal) => {
    const p = probe(terminal);
    const { deps, calls } = fakeDeps({});
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls).toMatchObject({ start: 0, opened: 0, closed: 0 });
    expect(p.out).toEqual([]);
    expect(p.err).toEqual([UI_TEXT.agentRun(PREFIX)]);
    expect(UI_TEXT.agentRun(PREFIX)).toContain(`\`${PREFIX} ui\``);
    expect(UI_TEXT.agentRun(PREFIX)).not.toMatch(/https?:\/\//);
  });
});

describe('agentlink ui opens on Home (U3-a, D-138; 08 §1)', () => {
  function fakeServer() {
    const calls: string[] = [];
    const server = {
      openHome: (...args: unknown[]) => {
        calls.push(`home:${args.length}`);
        return Promise.resolve(true);
      },
      openFirstRun: (...args: unknown[]) => {
        calls.push(`first-run:${args.length}`);
        return Promise.resolve(true);
      },
    };
    return { server, calls };
  }

  it('with an owner, the browser opens Home through openHome, with no argument', async () => {
    const { server, calls } = fakeServer();
    await expect(openUiPage('home', server)).resolves.toBe(true);
    expect(calls).toEqual(['home:0']);
  });

  it('while no owner exists, first run still opens the first-run page', async () => {
    const { server, calls } = fakeServer();
    await expect(openUiPage('first-run', server)).resolves.toBe(true);
    expect(calls).toEqual(['first-run:0']);
  });

  it('the production step uses openUiPage and no longer opens Activity', async () => {
    const text = await readFile(fileURLToPath(new URL('./ui.ts', import.meta.url)), 'utf8');
    const code = text.replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/openUiPage\(page, server\)/);
    expect(code).not.toMatch(/openActivity|'activity'/);
  });

  it('the terminal line names Home, never a link', () => {
    expect(UI_TEXT.opened).toContain('Home');
    expect(UI_TEXT.opened).not.toMatch(/activity|https?:\/\//i);
  });
});

describe('agentlink ui is not an MCP tool (M1-11b-9)', () => {
  it('no tool source mentions the ui command or the opener', async () => {
    const dir = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../../packages/mcp-tools/src',
    );
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = await readFile(join(dir, file), 'utf8');
      expect(text).not.toMatch(/openActivity|openHome|openFirstRun|commands\/ui/);
    }
  });
});

describe('agentlink ui on a computer with several agents (M1-UX-MULTI-AGENT)', () => {
  const TWO = ['agent-alpha', 'agent-beta'];

  it('without --agent it lists the names and offers a numbered pick, then opens that agent', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: TWO, answers: ['2'] });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual(['agent-beta']);
    const all = p.out.join('\n');
    expect(all).toContain('1. agent-alpha');
    expect(all).toContain('2. agent-beta');
    expect(p.err).toEqual([]);
  });

  it.each(['', '0', '3', 'agent-gamma', 'x'])(
    'a bad pick (%j) starts nothing, says "more than one agent" and names the --agent command',
    async (answer) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ agents: TWO, answers: [answer] });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
      expect(calls.start).toBe(0);
      const err = p.err.join('\n');
      expect(err).toContain('more than one');
      expect(err).toContain(`${PREFIX} ui --agent <name>`);
      expect(err).not.toContain(UI_TEXT.notReady(PREFIX));
    },
  );

  it('with --agent nothing is asked and the name is used', async () => {
    const p = probe(TTY, 'agent-alpha');
    const { deps, calls } = fakeDeps({ agents: TWO });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual(['agent-alpha']);
    expect(p.out.join('\n')).not.toContain('1. agent-alpha');
  });

  it('a default agent is used without asking', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: ['default', 'agent-beta'] });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual([undefined]);
  });

  it('no agent at all keeps the "not set up here yet" line', async () => {
    const p = probe(TTY);
    const { deps } = fakeDeps({ agents: [], start: 'none' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(p.err).toEqual([UI_TEXT.notReady(PREFIX)]);
  });

  it('run by an AI the fixed line stays and no names are listed', async () => {
    const p = probe(AGENT);
    const { deps, calls } = fakeDeps({ agents: TWO });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls.start).toBe(0);
    expect(p.err).toEqual([UI_TEXT.agentRun(PREFIX)]);
    expect(p.out).toEqual([]);
  });
});
