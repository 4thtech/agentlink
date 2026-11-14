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
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { OPEN_TEXT, setupOpenedLine } from '../runtime/open-watch.js';
import {
  UI_TEXT,
  UI_WAIT_MS,
  onStopSignals,
  openUiPage,
  startFailureNote,
  startUiServer,
  uiStep,
  type UiDeps,
  type UiPage,
} from './ui.js';

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
  /** F25: the host's page activity (absent: none reported). */
  readonly activity?: { lastAt(): number; openStreams(): number };
  /** The local agent names on this computer. */
  readonly agents?: readonly string[];
  /** U3-b: the last used agent (app.json). */
  readonly last?: string;
  /** U3-b: the agents an AI app serves. */
  readonly serves?: readonly string[];
  /** U3-g-b: the no-agent host (Welcome): absent, started, or not startable. */
  readonly welcome?: 'ok' | 'none';
}

function fakeDeps(script: Script) {
  const calls = {
    start: 0,
    opened: 0,
    closed: 0,
    unsubscribed: 0,
    welcome: 0,
    names: [] as (string | undefined)[],
  };
  let stop: (() => void) | undefined;
  const deps: UiDeps = {
    ...(script.agents === undefined
      ? {}
      : {
          agents: () => Promise.resolve(script.agents ?? []),
          lastUsed: () => Promise.resolve(script.last),
          serves: (name: string) => Promise.resolve((script.serves ?? []).includes(name)),
        }),
    ...(script.welcome === undefined
      ? {}
      : {
          startWelcome: () => {
            calls.welcome += 1;
            if (script.welcome === 'none') return Promise.resolve(undefined);
            return Promise.resolve({
              page: 'first-run' as const,
              open: () => {
                calls.opened += 1;
                setTimeout(() => stop?.(), 5);
                return Promise.resolve(true);
              },
              close: () => {
                calls.closed += 1;
                return Promise.resolve();
              },
            });
          },
        }),
    start: (name) => {
      calls.start += 1;
      calls.names.push(name);
      if (script.start === 'throws') return Promise.reject(new Error('keychain locked'));
      if (script.start === 'none') return Promise.resolve(undefined);
      return Promise.resolve({
        ...(script.activity === undefined ? {} : { activity: script.activity }),
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
      expect(p.out).toEqual([
        page === 'home' ? UI_TEXT.opened : UI_TEXT.openedSetup,
        UI_TEXT.closed(PREFIX),
      ]);
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

  it('stops after the idle limit and says so in one plain line (F25)', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ stop: 'never', waitMs: 30 });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([UI_TEXT.opened, UI_TEXT.closedIdle(PREFIX)]);
    expect(p.err).toEqual([]);
  });

  it('page activity resets the idle limit (F25)', async () => {
    const p = probe(TTY);
    let lastAt = Date.now();
    const started = Date.now();
    setTimeout(() => {
      lastAt = Date.now();
    }, 70);
    const activity = { lastAt: () => lastAt, openStreams: () => 0 };
    const { deps } = fakeDeps({ stop: 'never', waitMs: 100, activity });
    await uiStep(p.context, deps, PREFIX);
    expect(Date.now() - started).toBeGreaterThanOrEqual(165);
  });

  it('an open page (live stream) keeps it open (F25)', async () => {
    const p = probe(TTY);
    const started = Date.now();
    const activity = {
      lastAt: () => started,
      openStreams: () => (Date.now() - started < 200 ? 1 : 0),
    };
    const { deps } = fakeDeps({ stop: 'never', waitMs: 60, activity });
    await uiStep(p.context, deps, PREFIX);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('the idle line uses the prefix and the Ctrl+C line names no number (F25)', () => {
    expect(UI_TEXT.closedIdle(PREFIX)).toBe(
      `AgentLink closed after 30 minutes without use. Run \`${PREFIX}\` to open it again.`,
    );
    expect(UI_TEXT.closed(PREFIX)).toBe(`AgentLink closed. Run \`${PREFIX}\` to open it again.`);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    '%s stops the host cleanly and unsubscribes (F25)',
    (signal) => {
      const proc = new EventEmitter();
      let stopped = 0;
      const off = onStopSignals(() => (stopped += 1), proc as unknown as NodeJS.Process);
      proc.emit(signal);
      expect(stopped).toBe(1);
      off();
      expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
      expect(proc.listenerCount('SIGHUP')).toBe(0);
    },
  );

  it('the limit is 30 minutes', () => {
    expect(UI_WAIT_MS).toBe(30 * 60_000);
  });

  it('an agent that is not set up (no diagnosis): the fixed init line, exit 1', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ start: 'none' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls).toMatchObject({ opened: 0 });
    expect(p.err).toEqual([UI_TEXT.notReady(PREFIX)]);
    expectNoLink(p);
  });

  it('a server that cannot start says so without asking for init (R1)', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ start: 'throws' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls).toMatchObject({ opened: 0 });
    expect(p.err).toEqual([UI_TEXT.startFailure.failed(PREFIX)]);
    expectNoLink(p);
  });

  it.each([false, 'throws'] as const)(
    'no browser (%s): keeps serving, prints no link (R1)',
    async (opens) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ opens, stop: 'never', waitMs: 30 });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
      expect(calls).toMatchObject({ opened: 1, closed: 1 });
      expect(p.err).toEqual([]);
      expect(p.out[0]).toBe(UI_TEXT.noBrowser);
      expectNoLink(p);
    },
  );
});

// F40: the opened line says "Opening…"; when no one-shot link is used within the check time, one
// follow-up asks for Enter, which opens a fresh link. Nothing printed holds the link.
describe('agentlink ui when the browser does not show the page (F40)', () => {
  function withWatch(used: () => number) {
    const p = probe(TTY);
    let press: (() => void) | undefined;
    let stop: (() => void) | undefined;
    let opened = 0;
    const deps: UiDeps = {
      start: () =>
        Promise.resolve({
          page: 'home' as const,
          activity: { lastAt: () => Date.now(), openStreams: () => 0, linksUsed: used },
          open: () => {
            opened += 1;
            return Promise.resolve(true);
          },
          close: () => Promise.resolve(),
        }),
      waitMs: 5_000,
      openCheckMs: 10,
      onEnter: (handler) => {
        press = handler;
        return () => {
          press = undefined;
        };
      },
      interrupt: (handler) => {
        stop = handler;
        return () => undefined;
      },
    };
    return { p, deps, enter: () => press?.(), stop: () => stop?.(), opened: () => opened };
  }

  it('no link used: the follow-up, Enter opens again, Ctrl+C closes', async () => {
    const h = withWatch(() => 0);
    const run = uiStep(h.p.context, h.deps, PREFIX);
    await new Promise((r) => setTimeout(r, 40));
    expect(h.p.out).toEqual([UI_TEXT.opened, OPEN_TEXT.notOpened]);
    h.enter();
    await new Promise((r) => setTimeout(r, 1));
    expect(h.opened()).toBe(2);
    expect(h.p.out.at(-1)).toBe(OPEN_TEXT.retrying);
    h.stop();
    await expect(run).resolves.toBe(EXIT_OK);
    expectNoLink(h.p);
  });

  it('a link used: no follow-up', async () => {
    let used = 0;
    const h = withWatch(() => used);
    const run = uiStep(h.p.context, h.deps, PREFIX);
    await new Promise((r) => setTimeout(r, 1));
    used = 1;
    await new Promise((r) => setTimeout(r, 40));
    h.stop();
    await expect(run).resolves.toBe(EXIT_OK);
    expect(h.p.out).toEqual([UI_TEXT.opened, UI_TEXT.closed(PREFIX)]);
  });

  it('the opened lines say "Opening", never that the browser opened (F40, F41)', () => {
    expect(UI_TEXT.opened.startsWith('Opening AgentLink')).toBe(true);
    expect(UI_TEXT.openedSetup).toBe(setupOpenedLine(process.platform));
    for (const line of [UI_TEXT.opened, UI_TEXT.openedSetup]) {
      expect(line).not.toMatch(/browser opened|setup page/i);
    }
  });
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

describe('agentlink ui never asks which agent (U3-b)', () => {
  const FOUR = ['agent-a', 'agent-b', 'agent-c', 'agent-d'];

  it.each([[[]], [['solo']], [FOUR]])('with %j nothing is asked', async (agents) => {
    const p = probe(TTY);
    const { deps } = fakeDeps({
      agents,
      ...(agents.length === 0 ? { start: 'none' as const } : {}),
    });
    await uiStep(p.context, deps, PREFIX);
    expect(p.out.join('\n')).not.toMatch(/Which one|Type its number|1\. /);
    expect(p.err.join('\n')).not.toMatch(/more than one|--agent <name>/);
  });

  it('opens the last used agent (app.json)', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: FOUR, last: 'agent-c', serves: ['agent-b'] });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual(['agent-c']);
  });

  it('else the agent an AI app serves, default first', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({
      agents: ['agent-a', 'agent-b', 'default'],
      serves: ['agent-b', 'default'],
    });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual([undefined]);
  });

  it('else the first by name', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: FOUR });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual(['agent-a']);
  });

  it('with --agent the name is used', async () => {
    const p = probe(TTY, 'agent-b');
    const { deps, calls } = fakeDeps({ agents: FOUR, last: 'agent-c' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls.names).toEqual(['agent-b']);
  });

  it('no agent at all keeps the "not set up here yet" line', async () => {
    const p = probe(TTY);
    const { deps } = fakeDeps({ agents: [], start: 'none' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(p.err).toEqual([UI_TEXT.notReady(PREFIX)]);
  });

  it('run by an AI the fixed line stays and nothing is looked up', async () => {
    const p = probe(AGENT);
    const { deps, calls } = fakeDeps({ agents: FOUR });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls.start).toBe(0);
    expect(p.err).toEqual([UI_TEXT.agentRun(PREFIX)]);
    expect(p.out).toEqual([]);
  });

  it('the picker is gone', async () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    await expect(readFile(join(dir, 'agent-choice.ts'), 'utf8')).rejects.toThrow();
  });
});

// U3-g-b (08 §1 "with no agent yet, Welcome"; USABILITY-WAVE-3 §7.4): a brand-new user with no agent
// folder at all runs `agentlink ui` (or bare `agentlink`): the app host starts with no agent open and
// the browser opens the first-run page (Welcome), never the "not set up here yet" line.
describe('agentlink ui with no agent at all opens Welcome (U3-g-b)', () => {
  it('starts the no-agent host and opens the first-run page', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: [], welcome: 'ok' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls).toMatchObject({ welcome: 1, start: 0, opened: 1, closed: 1 });
    expect(p.out).toEqual([UI_TEXT.openedSetup, UI_TEXT.closed(PREFIX)]);
    expect(p.err).toEqual([]);
    expectNoLink(p);
  });

  it('falls back to the agent open path when the no-agent host cannot start', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: [], welcome: 'none', start: 'none' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls).toMatchObject({ welcome: 1, start: 1 });
    expect(p.err).toEqual([UI_TEXT.notReady(PREFIX)]);
  });

  it('with any agent the no-agent host is never started', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ agents: ['solo'], welcome: 'ok' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_OK);
    expect(calls).toMatchObject({ welcome: 0, start: 1 });
  });

  it('with --agent the named agent is opened, never Welcome', async () => {
    const p = probe(TTY, 'work');
    const { deps, calls } = fakeDeps({ agents: [], welcome: 'ok', start: 'none' });
    await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(calls).toMatchObject({ welcome: 0, start: 1 });
    expect(calls.names).toEqual(['work']);
  });

  it.each([AGENT, PIPE])(
    'run by an AI it prints the fixed line and opens nothing (D-39)',
    async (t) => {
      const p = probe(t);
      const { deps, calls } = fakeDeps({ agents: [], welcome: 'ok' });
      await expect(uiStep(p.context, deps, PREFIX)).resolves.toBe(EXIT_FAILED);
      expect(calls).toMatchObject({ welcome: 0, start: 0, opened: 0 });
      expect(p.err).toEqual([UI_TEXT.agentRun(PREFIX)]);
      expect(p.out).toEqual([]);
    },
  );

  it('the production step wires the no-agent host', async () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const source = await readFile(join(dir, 'ui.ts'), 'utf8');
    expect(source).toContain('startWelcome:');
    expect(source).toContain('startUiWelcome(');
  });
});

describe('a failed app host start leaves one fixed diagnostic line (WIN-STARTUP-LOG)', () => {
  it('names the reason and a short error code, never the error message or a path', async () => {
    const notes: string[] = [];
    const thrown = Object.assign(new Error('C:\\Users\\me\\.agentlink\\agents\\x secret=abc'), {
      code: 'identity_missing',
    });
    const { deps } = fakeDeps({ agents: ['solo'] });
    const result = await startUiServer(
      {
        ...deps,
        start: () => Promise.reject(thrown),
        diagnose: () => Promise.resolve('open' as const),
        note: (line) => notes.push(line),
      },
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(notes).toEqual(['app host did not start: reason=open code=identity_missing']);
  });

  it('a code that is not a short identifier becomes none', () => {
    expect(startFailureNote('open', Object.assign(new Error('x'), { code: 'a b/c' }))).toBe(
      'app host did not start: reason=open code=none',
    );
    expect(startFailureNote('no_owner', undefined)).toBe(
      'app host did not start: reason=no_owner code=none',
    );
  });

  it('a note that throws does not change the result', async () => {
    const { deps } = fakeDeps({ agents: ['solo'] });
    const result = await startUiServer(
      {
        ...deps,
        start: () => Promise.resolve(undefined),
        diagnose: () => Promise.resolve('keychain' as const),
        note: () => {
          throw new Error('boom');
        },
      },
      undefined,
    );
    expect(result).toEqual({ ok: false, failure: 'keychain' });
  });
});
