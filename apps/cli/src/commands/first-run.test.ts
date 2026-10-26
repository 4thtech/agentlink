// M1-11b-6: `init` hands a new owner to the local app's first-run page (D-120 (1); 08 §1).
//
// - In the owner's own interactive terminal: the approval server starts with owner setup wired and
//   the OS browser opens the one-shot session link at /first-run. The link goes only to the opener;
//   it is never printed, logged or returned. The command waits while the owner uses the page (setup,
//   then the settings pages) and stops on Ctrl+C or after a time limit.
// - Run by an agent (no TTY, a harness marker, or `--confirm`): no server, no browser, no link; one
//   fixed line tells the user to run `agentlink init` in their own terminal.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@4thtech-io/log';
import type {
  ApprovalServer,
  ApprovalServerEvent,
  ApprovalServerOptions,
  LocalUiOptions,
} from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../dispatch.js';
import type { TerminalContext } from '../runtime/guards.js';
import {
  FIRST_RUN_TEXT,
  firstRunStep,
  nodeFirstRunDeps,
  type FirstRunDeps,
  type FirstRunSeams,
} from './first-run.js';
import type { OwnerAgent } from './owner/deps.js';

const TTY: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };
const AGENT: TerminalContext = { stdinIsTTY: true, stdoutIsTTY: true, env: { CLAUDECODE: '1' } };
const PIPE: TerminalContext = { stdinIsTTY: false, stdoutIsTTY: false, env: {} };
/** The command as this run was started (M1-36a `cliPrefix`), as init passes it on. */
const PREFIX = 'npx -y @4thtech-io/agentlink';

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
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(true);
    expect(calls).toMatchObject({ start: 1, opened: 1, closed: 1, available: 0 });
    expect(calls.unsubscribed).toBeGreaterThan(0);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.done]);
    expect(p.err).toEqual([]);
    expectNoLink(p);
  });

  it('when no owner can be set up here (owner exists, file KeyStore, no app): nothing at all', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ start: 'none' });
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(false);
    expect(calls).toMatchObject({ start: 1, opened: 0, closed: 0 });
    expect(p.out).toEqual([]);
  });

  it('a server that cannot start leaves the terminal way (false, nothing printed)', async () => {
    const p = probe(TTY);
    const { deps } = fakeDeps({ start: 'throws' });
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(false);
    expect(p.out).toEqual([]);
    expect(p.err).toEqual([]);
  });

  it.each([false, 'throws'] as const)(
    'no browser (%s): the server closes at once and the link is never shown',
    async (opens) => {
      const p = probe(TTY);
      const { deps, calls } = fakeDeps({ opens });
      await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(false);
      expect(calls).toMatchObject({ opened: 1, closed: 1 });
      expect(p.out).toEqual([FIRST_RUN_TEXT.noBrowser]);
      expectNoLink(p);
    },
  );

  it('Ctrl+C before setup finished: closes and falls back to the terminal way', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ setUp: 'never', stop: 'at_once' });
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(false);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.notFinished]);
  });

  it('stops waiting after the time limit', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ setUp: 'never', stop: 'never', waitMs: 30 });
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(false);
    expect(calls.closed).toBe(1);
    expect(p.out).toEqual([FIRST_RUN_TEXT.opened, FIRST_RUN_TEXT.notFinished]);
  });

  it('after setup, the time limit also ends the settings wait (still set up)', async () => {
    const p = probe(TTY);
    const { deps, calls } = fakeDeps({ stop: 'never', waitMs: 60 });
    await expect(firstRunStep(p.context, 'default', true, PREFIX, deps)).resolves.toBe(true);
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
      await expect(firstRunStep(p.context, 'default', interactive, PREFIX, deps)).resolves.toBe(
        true,
      );
      expect(calls).toMatchObject({ start: 0, opened: 0, available: 1 });
      expect(p.out).toEqual([FIRST_RUN_TEXT.agentRun(PREFIX)]);
      expectNoLink(p);
    },
  );

  it('prints nothing when no owner can be set up here, or the check fails', async () => {
    for (const available of [false, 'throws'] as const) {
      const p = probe(AGENT);
      const { deps } = fakeDeps({ available: available === false ? false : true });
      if (available === 'throws') deps.available = () => Promise.reject(new Error('locked'));
      await expect(firstRunStep(p.context, 'default', false, PREFIX, deps)).resolves.toBe(false);
      expect(p.out).toEqual([]);
    }
  });
});

describe('FIRST_RUN_TEXT (11 §5)', () => {
  const texts = (): string[] =>
    Object.values(FIRST_RUN_TEXT).map((t) => (typeof t === 'function' ? t(PREFIX) : t));

  it('uses plain words: no wallet, gas, seed phrase, transaction or chain', () => {
    for (const text of texts()) {
      expect(text).not.toMatch(/wallet|\bgas\b|seed phrase|transaction|\bchain\b|https?:/i);
    }
  });

  it('the agent line never asks the agent to open the page', () => {
    expect(FIRST_RUN_TEXT.agentRun(PREFIX)).toContain('own terminal');
  });

  it('M1-36e: the agent line names the command as it was started, never a bare `agentlink`', () => {
    const line = FIRST_RUN_TEXT.agentRun(PREFIX);
    expect(line).toContain(`\`${PREFIX} init\``);
    expect(line).toContain(`\`${PREFIX} owner init\``);
    expect(line.replaceAll(PREFIX, '')).not.toMatch(/\bagentlink /);
  });
});

/** Every non-test source file under `dir`. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('the first-run link never reaches an agent (M1-11b-6, G-1)', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));

  // M1-11b-8: `agentlink mcp` opens the page once per start (06 §7). In the MCP server only the
  // approval UI's `openSetupPage` calls the server's opener, only the start step calls
  // `openSetupPage`, and only command.ts runs the start step; no tool or tool handler does.
  it('no MCP tool opens the first-run page; in the MCP server only the start step does (M1-11b-8)', async () => {
    const mcp = await sources(join(src, 'mcp'));
    const tools = await sources(join(src, '..', '..', '..', 'packages', 'mcp-tools', 'src'));
    expect(tools.length).toBeGreaterThan(10);
    const allowed: Readonly<Record<string, RegExp>> = {
      'approval-ui.ts': /\bopenFirstRun\b|\bopenSetupPage\b/,
      'first-run-on-start.ts': /\bopenSetupPage\b|\bopenFirstRunOnStart\b/,
      'command.ts': /\bopenFirstRunOnStart\b/,
    };
    const offenders: string[] = [];
    for (const file of [...mcp, ...tools]) {
      const text = await readFile(file, 'utf8');
      // Code, not the comments that name the step: a call, an import, or a link to the page.
      const code = text.replace(/^\s*\/\/.*$/gm, '');
      if (/commands\/first-run|['"`]\/first-run\?|\?t=/.test(code)) offenders.push(file);
      const base = mcp.includes(file) ? (file.split(/[\\/]/).pop() ?? '') : '';
      const own = allowed[base];
      const left = own === undefined ? code : code.replace(new RegExp(own.source, 'g'), '');
      if (/\bopenFirstRun\b|\bopenSetupPage\b|\bopenFirstRunOnStart\b/.test(left)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the approval UI passes the opener nothing and gets only a boolean back (M1-11b-8)', async () => {
    const text = await readFile(join(src, 'mcp', 'approval-ui.ts'), 'utf8');
    expect(text).toMatch(/openSetupPage\(\): Promise<boolean>;/);
    expect(text).toMatch(/\.openFirstRun\(\)/);
    expect(text).not.toMatch(/\.openFirstRun\([^)]/);
  });

  it('the step never prints, returns or logs a link: the server seam only answers a boolean', async () => {
    const text = await readFile(join(src, 'commands', 'first-run.ts'), 'utf8');
    expect(text).toMatch(/openFirstRun\(\): Promise<boolean>;/);
    expect(text).not.toMatch(/\?t=|https?:\/\//);
  });
});

// ---- IR-M1-11b-6-1 L-2: the production seams of the step (M1-11b-8) ------------------------------

function seamAgent() {
  const closed = { count: 0 };
  const agent: OwnerAgent = Object.freeze({
    name: 'default',
    client: { agentId: `0x${'a'.repeat(40)}` } as unknown as OwnerAgent['client'],
    store: {} as OwnerAgent['store'],
    cipher: {} as OwnerAgent['cipher'],
    close: () => {
      closed.count += 1;
      return Promise.resolve();
    },
  });
  return { agent, closed };
}

const WIRED = {
  assets: { files: new Map([['index.html', { body: new Uint8Array(1), type: 'text/html' }]]) },
  ownerSetup: { firstCard: {} },
} as unknown as LocalUiOptions;
const NOT_WIRED = { assets: WIRED.assets } as LocalUiOptions;
const NO_APP = { ownerSetup: WIRED.ownerSetup } as LocalUiOptions;

function seams(localUi: LocalUiOptions, open: 'ok' | 'needs_setup' = 'ok') {
  const { agent, closed } = seamAgent();
  const serverClosed = { count: 0 };
  const firstRunOpens = { count: 0 };
  const started: ApprovalServerOptions[] = [];
  const seam: Partial<FirstRunSeams> = {
    owner: {
      open: () =>
        Promise.resolve(
          open === 'ok'
            ? { status: 'ok' as const, agent }
            : { status: 'needs_setup' as const, message: 'Set up first.' },
        ),
    },
    localUi: () => Promise.resolve(localUi),
    startServer: (options) => {
      started.push(options);
      return Promise.resolve({
        openFirstRun: () => {
          firstRunOpens.count += 1;
          return Promise.resolve(true);
        },
        close: () => {
          serverClosed.count += 1;
          return Promise.resolve();
        },
      } as unknown as ApprovalServer);
    },
    logger: createLogger({ sink: () => undefined }),
  };
  return { seam, closed, serverClosed, firstRunOpens, started };
}

describe('nodeFirstRunDeps seams (IR-M1-11b-6-1 L-2)', () => {
  it('available: true only with owner setup wired and the app in this build; closes the agent', async () => {
    for (const [localUi, expected] of [
      [WIRED, true],
      [NOT_WIRED, false],
      [NO_APP, false],
    ] as const) {
      const s = seams(localUi);
      await expect(nodeFirstRunDeps(s.seam).available('default')).resolves.toBe(expected);
      expect(s.closed.count).toBe(1);
      expect(s.started).toEqual([]);
    }
  });

  it('available: false when the agent cannot be opened', async () => {
    const s = seams(WIRED, 'needs_setup');
    await expect(nodeFirstRunDeps(s.seam).available('default')).resolves.toBe(false);
    expect(s.started).toEqual([]);
  });

  it('start: no server and the agent closed when setup is not wired or the app is missing', async () => {
    for (const localUi of [NOT_WIRED, NO_APP]) {
      const s = seams(localUi);
      await expect(
        nodeFirstRunDeps(s.seam).start('default', () => undefined),
      ).resolves.toBeUndefined();
      expect(s.started).toEqual([]);
      expect(s.closed.count).toBe(1);
    }
  });

  it('start: serves the wired setup; the source never closes the agent; close stops both', async () => {
    const s = seams(WIRED);
    let setUp = 0;
    const server = await nodeFirstRunDeps(s.seam).start('default', () => {
      setUp += 1;
    });
    expect(server).toBeDefined();
    expect(s.started).toHaveLength(1);
    const options = s.started[0];
    expect(options?.localUi).toBe(WIRED);
    // A finished owner setup reaches onSetUp; other events do not.
    options?.onEvent?.({ kind: 'listening' });
    options?.onEvent?.({ kind: 'owner_setup', outcome: 'done' } as ApprovalServerEvent);
    expect(setUp).toBe(1);
    await expect(server?.openFirstRun()).resolves.toBe(true);
    expect(s.firstRunOpens.count).toBe(1);
    expect(s.closed.count).toBe(0);
    await server?.close();
    expect(s.serverClosed.count).toBe(1);
    expect(s.closed.count).toBe(1);
  });

  it('start: a server that fails to start closes the agent and rethrows', async () => {
    const s = seams(WIRED);
    const seam: Partial<FirstRunSeams> = {
      ...s.seam,
      startServer: () => Promise.reject(new Error('EADDRINUSE')),
    };
    await expect(nodeFirstRunDeps(seam).start('default', () => undefined)).rejects.toThrow(
      'EADDRINUSE',
    );
    expect(s.closed.count).toBe(1);
  });
});
