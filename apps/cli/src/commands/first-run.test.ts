// M1-11b-6: `init` hands a new owner to the local app's first-run page (D-120 (1); 08 §1).
//
// - In the owner's own interactive terminal: the approval server starts with owner setup wired and
//   the OS browser opens the one-shot session link at /first-run. The link goes only to the opener;
//   it is never printed, logged or returned. The command waits while the owner uses the page (setup,
//   then the settings pages) and stops on Ctrl+C or after a time limit.
// - Run by an agent (no TTY, a harness marker, or `--confirm`): no server, no browser, no link; one
//   fixed line tells the user to run `agentlink init` in their own terminal.
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import { FIRST_RUN_TEXT, firstRunStep, type FirstRunDeps } from './first-run.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const AGENT: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };

interface Probe {
  readonly out: string[];
  readonly err: string[];
  readonly context: CommandContext;
}

function probe(terminal: TerminalContext): Probe {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    context: {
      command: 'init',
      parsed: {} as CommandContext['parsed'],
      output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
      terminal,
    },
  };
}

interface Script {
  readonly available?: boolean;
  readonly start?: 'none' | 'throws';
  readonly opens?: boolean | 'throws';
  /** When the page finishes setup: right after the browser opens, or never. */
  readonly setUp?: 'after_open' | 'never';
  /** When the owner presses Ctrl+C: after setup, at once, or never. */
  readonly stop?: 'after_setup' | 'at_once' | 'never';
  readonly waitMs?: number;
}

function fakeDeps(script: Script) {
  const calls = { start: 0, opened: 0, closed: 0, available: 0, unsubscribed: 0 };
  let onSetUp: (() => void) | undefined;
  let stop: (() => void) | undefined;
  const deps: FirstRunDeps = {
    available: () => {
      calls.available += 1;
      return Promise.resolve(script.available ?? true);
    },
    start: (_name, setUp) => {
      calls.start += 1;
      if (script.start === 'throws') return Promise.reject(new Error('keychain locked'));
      if (script.start === 'none') return Promise.resolve(undefined);
      onSetUp = setUp;
      return Promise.resolve({
        openFirstRun: () => {
          calls.opened += 1;
          if (script.opens === 'throws') return Promise.reject(new Error('opener'));
          const opened = script.opens ?? true;
          if (opened && (script.setUp ?? 'after_open') === 'after_open') {
            setTimeout(() => {
              onSetUp?.();
              if ((script.stop ?? 'after_setup') === 'after_setup') setTimeout(() => stop?.(), 5);
            }, 5);
          }
          if (opened && script.stop === 'at_once') setTimeout(() => stop?.(), 5);
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

/** Nothing printed may hold a link, a token or an address of the local server. */
function expectNoLink(p: Probe): void {
  const all = [...p.out, ...p.err].join('\n');
  expect(all).not.toMatch(/https?:\/\//);
  expect(all).not.toContain('?t=');
  expect(all).not.toContain('localhost');
}

describe('firstRunStep in the owner terminal (M1-11b-6)', () => {
  it('opens the first-run page, waits for setup and the settings pages, then stops on Ctrl+C', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({});
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(true);
    expect(calls).toMatchObject({ start: 1, opened: 1, closed: 1, available: 0 });
    expect(calls.unsubscribed).toBeGreaterThan(0);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.done]);
    expect(p.err).toEqual([]);
    expectNoLink(p);
  });

  it('when no owner can be set up here (owner exists, file KeyStore, no app): nothing at all', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ start: 'none' });
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(false);
    expect(calls).toMatchObject({ start: 1, opened: 0, closed: 0 });
    expect(p.out).toEqual([]);
  });

  it('a server that cannot start leaves the terminal way (false, nothing printed)', async () => {
    const p = probe(TTY);
    const { deps } = fakeDeps({ start: 'throws' });
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(false);
    expect(p.out).toEqual([]);
    expect(p.err).toEqual([]);
  });

  it.each([false, 'throws'] as const)(
    'no browser (%s): the server closes at once and the link is never shown',
    async (opens) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ opens });
      await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(false);
      expect(calls).toMatchObject({ opened: 1, closed: 1 });
      expect(p.out).toEqual([FIRST_RUN_TEXT.noBrowser]);
      expectNoLink(p);
    },
  );

  it('Ctrl+C before setup finished: closes and falls back to the terminal way', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ setUp: 'never', stop: 'at_once' });
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(false);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.notFinished]);
  });

  it('stops waiting after the time limit', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ setUp: 'never', stop: 'never', waitMs: 30 });
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(false);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.notFinished]);
  });

  it('after setup, the time limit also ends the settings wait (still set up)', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ stop: 'never', waitMs: 60 });
    await expect(firstRunStep(p.context, 'default', true, deps)).resolves.toBe(true);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.done]);
  });
});

describe('firstRunStep run by an agent (M1-11b-6)', () => {
  it.each([
    ['a harness marker', AGENT, true],
    ['no terminal', PIPE, true],
    ['--confirm in a terminal', TTY, false],
  ] as const)(
    'with %s: no server, no browser, no link; one fixed line',
    async (_label, terminal, interactive) => {
      const p = probe(terminal);
      const { deps, calls } = fakeDeps({});
      await expect(firstRunStep(p.context, 'default', interactive, deps)).resolves.toBe(true);
      expect(calls).toMatchObject({ start: 0, opened: 0, available: 1 });
      expect(p.out).toEqual([FIRST_RUN_TEXT.agentRun]);
      expectNoLink(p);
    },
  );

  it('prints nothing when no owner can be set up here, or the check fails', async () => {
    for (const available of [false, 'throws'] as const) {
      const p = probe(AGENT);
      const { deps } = fakeDeps({ available: available === false ? false : true });
      if (available === 'throws') deps.available = () => Promise.reject(new Error('locked'));
      await expect(firstRunStep(p.context, 'default', false, deps)).resolves.toBe(false);
      expect(p.out).toEqual([]);
    }
  });
});

describe('FIRST_RUN_TEXT (11 §5)', () => {
  it('uses plain words: no wallet, gas, seed phrase, transaction or chain', () => {
    for (const text of Object.values(FIRST_RUN_TEXT)) {
      expect(text).not.toMatch(/wallet|\bgas\b|seed phrase|transaction|\bchain\b|https?:/i);
    }
  });

  it('the agent line never asks the agent to open the page', () => {
    expect(FIRST_RUN_TEXT.agentRun).toContain('agentlink init');
    expect(FIRST_RUN_TEXT.agentRun).toContain('own terminal');
  });
});
