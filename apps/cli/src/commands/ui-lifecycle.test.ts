// R1: `ui` stays up on stray background errors, keeps serving when the browser cannot open, says
// why it could not start (never "run init" when IDs exist) and records why it closed.
import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../dispatch.js';
import type { LastExitReason } from '../runtime/last-exit.js';
import { UI_TEXT, serveUi, type StartFailure, type UiDeps } from './ui.js';

const PREFIX = 'npx -y @4thtech-io/agentlink';
const ORIGIN = 'http://localhost:51234';

function probe() {
  const out: string[] = [];
  const err: string[] = [];
  const context: CommandContext = {
    command: 'ui',
    parsed: { values: {}, positionals: [], agent: undefined },
    output: { print: (t) => out.push(t), printError: (t) => err.push(t) },
    terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {} },
  };
  return { out, err, context };
}

interface Script {
  readonly start?: 'none' | Error;
  readonly opens?: boolean;
  readonly diagnose?: StartFailure;
  readonly waitMs?: number;
}

function fake(script: Script = {}) {
  const calls = {
    closed: 0,
    exits: [] as LastExitReason[],
    guardOff: 0,
    diagnosed: 0,
  };
  let stop: ((signal?: string) => void) | undefined;
  let fatal: ((reason: 'uncaught' | 'rejections') => void) | undefined;
  const deps: UiDeps = {
    start: () => {
      if (script.start instanceof Error) return Promise.reject(script.start);
      if (script.start === 'none') return Promise.resolve(undefined);
      return Promise.resolve({
        page: 'home' as const,
        origin: ORIGIN,
        open: () => Promise.resolve(script.opens ?? true),
        close: () => {
          calls.closed += 1;
          return Promise.resolve();
        },
      });
    },
    ...(script.diagnose === undefined
      ? {}
      : {
          diagnose: () => {
            calls.diagnosed += 1;
            return Promise.resolve(script.diagnose as StartFailure);
          },
        }),
    guard: (onFatal) => {
      fatal = onFatal;
      return () => {
        calls.guardOff += 1;
      };
    },
    recordExit: (reason) => {
      calls.exits.push(reason);
      return Promise.resolve();
    },
    waitMs: script.waitMs ?? 60_000,
    interrupt: (handler) => {
      stop = handler;
      return () => undefined;
    },
  };
  return {
    deps,
    calls,
    signal: (s?: string) => stop?.(s),
    breakDown: (r: 'uncaught' | 'rejections') => fatal?.(r),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('ui keeps serving on a stray error and closes cleanly on a fatal one (R1)', () => {
  it('installs the guard for the whole run and removes it after', async () => {
    const f = fake();
    const p = probe();
    const run = serveUi(p.context, f.deps, PREFIX);
    await tick();
    expect(f.calls.guardOff).toBe(0);
    f.signal('SIGINT');
    await run;
    expect(f.calls.guardOff).toBe(1);
  });

  it('a fatal problem closes the server, prints one exit line and exits 1', async () => {
    const f = fake();
    const p = probe();
    const run = serveUi(p.context, f.deps, PREFIX);
    await tick();
    f.breakDown('uncaught');
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(f.calls.closed).toBe(1);
    expect(p.out).toEqual([UI_TEXT.opened, UI_TEXT.closedProblem(PREFIX)]);
    expect(f.calls.exits).toEqual(['uncaught']);
  });

  it('a storm of rejections is recorded as "rejections"', async () => {
    const f = fake();
    const run = serveUi(probe().context, f.deps, PREFIX);
    await tick();
    f.breakDown('rejections');
    await run;
    expect(f.calls.exits).toEqual(['rejections']);
  });

  it.each([
    ['SIGINT', 'ctrl_c'],
    ['SIGTERM', 'sigterm'],
    ['SIGHUP', 'sighup'],
    [undefined, 'ctrl_c'],
  ] as const)('%s is recorded as %s', async (signal, reason) => {
    const f = fake();
    const p = probe();
    const run = serveUi(p.context, f.deps, PREFIX);
    await tick();
    f.signal(signal);
    await expect(run).resolves.toBe(EXIT_OK);
    expect(f.calls.exits).toEqual([reason]);
    expect(p.out.at(-1)).toBe(UI_TEXT.closed(PREFIX));
  });

  it('the idle limit is recorded as "idle"', async () => {
    const f = fake({ waitMs: 20 });
    await serveUi(probe().context, f.deps, PREFIX);
    expect(f.calls.exits).toEqual(['idle']);
  });
});

describe('a browser that will not open does not stop a healthy host (R1)', () => {
  it('prints the local address, keeps serving until stopped, then exits 0', async () => {
    const f = fake({ opens: false });
    const p = probe();
    let settled = false;
    const run = serveUi(p.context, f.deps, PREFIX).then((code) => {
      settled = true;
      return code;
    });
    await tick();
    expect(settled).toBe(false);
    expect(f.calls.closed).toBe(0);
    expect(p.out).toEqual([UI_TEXT.noBrowserServing(ORIGIN)]);
    expect(p.err).toEqual([]);
    expect(p.out.join('\n')).not.toContain('?t=');
    f.signal('SIGINT');
    await expect(run).resolves.toBe(EXIT_OK);
    expect(f.calls.closed).toBe(1);
    expect(f.calls.exits).toEqual(['ctrl_c']);
  });

  it('the line says it is still running and names Ctrl+C', () => {
    const line = UI_TEXT.noBrowserServing(ORIGIN);
    expect(line).toContain(ORIGIN);
    expect(line).toContain('still running');
    expect(line).toContain('Ctrl+C');
  });
});

describe('a start failure says what went wrong (R1)', () => {
  const REASONS: readonly [StartFailure, LastExitReason][] = [
    ['no_owner', 'start_no_owner'],
    ['no_ids', 'start_no_ids'],
    ['only_removing', 'start_removing'],
    ['port', 'start_port'],
    ['keychain', 'start_keychain'],
    ['open', 'start_open'],
    ['failed', 'start_failed'],
  ];

  it.each(REASONS)('%s has its own line and exit record', async (reason, exit) => {
    const f = fake({ start: 'none', diagnose: reason });
    const p = probe();
    await expect(serveUi(p.context, f.deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(p.err).toEqual([UI_TEXT.startFailure[reason](PREFIX)]);
    expect(f.calls.exits).toEqual([exit]);
    expect(f.calls.closed).toBe(0);
  });

  it('only the no-owner line tells the person to run init', () => {
    for (const [reason] of REASONS) {
      const line = UI_TEXT.startFailure[reason](PREFIX);
      if (reason === 'no_owner') expect(line).toContain(`${PREFIX} init`);
      else expect(line).not.toMatch(/\binit\b/);
    }
  });

  it('every line is distinct', () => {
    const lines = REASONS.map(([reason]) => UI_TEXT.startFailure[reason](PREFIX));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('a bind failure that is thrown is a port problem without asking for a diagnosis', async () => {
    const f = fake({ start: Object.assign(new Error('listen /x'), { code: 'EADDRINUSE' }) });
    const p = probe();
    await expect(serveUi(p.context, f.deps, PREFIX)).resolves.toBe(EXIT_FAILED);
    expect(p.err).toEqual([UI_TEXT.startFailure.port(PREFIX)]);
    expect(f.calls.exits).toEqual(['start_port']);
  });

  it('any other thrown error is diagnosed, and never prints its text', async () => {
    const f = fake({ start: new Error('secret /Users/x'), diagnose: 'keychain' });
    const p = probe();
    await serveUi(p.context, f.deps, PREFIX);
    expect(f.calls.diagnosed).toBe(1);
    expect(p.err).toEqual([UI_TEXT.startFailure.keychain(PREFIX)]);
    expect(p.err.join('\n')).not.toContain('secret');
  });

  it('with no diagnosis a thrown error says "couldn\'t start", not "run init"', async () => {
    const f = fake({ start: new Error('x') });
    const p = probe();
    await serveUi(p.context, f.deps, PREFIX);
    expect(p.err).toEqual([UI_TEXT.startFailure.failed(PREFIX)]);
  });
});
