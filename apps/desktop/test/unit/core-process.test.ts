// The core supervisor (src/main/core-process.ts): clean env, fixed argv, fd 3 only, backoff,
// protocol violations stop the core, clean shutdown on quit.
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CoreSupervisor,
  KILL_GRACE_MS,
  MAX_FAST_FAILURES,
  SHUTDOWN_GRACE_MS,
  STABLE_RUN_MS,
  aiAppMarkerSet,
  cleanCoreEnv,
  coreSpawnEnv,
  type SupervisorState,
} from '../../src/main/core-process.js';
import type { CoreMessage } from '../../src/shared/protocol.js';
import { FakeTimers, fakeSpawn, readyLine } from './fakes.js';

const NODE = '/Applications/AgentLink.app/Contents/Resources/node/bin/node';
const HOST =
  '/Applications/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/desktop-host.js';

function setup(env: Record<string, string> = { HOME: '/Users/x', PATH: '/usr/bin' }) {
  const timers = new FakeTimers();
  const { spawn, children } = fakeSpawn();
  const messages: CoreMessage[] = [];
  const stderr: string[] = [];
  const exits: Array<[number | null, string | null]> = [];
  const states: SupervisorState[] = [];
  let starts = 0;
  const violations: string[] = [];
  const supervisor = new CoreSupervisor({
    nodePath: NODE,
    hostScript: HOST,
    cwd: '/Users/x',
    env,
    platform: 'darwin',
    spawn,
    timers,
    onMessage: (m) => messages.push(m),
    onStart: () => {
      starts += 1;
    },
    onViolation: (v) => violations.push(v),
    onStateChange: (s) => states.push(s),
    onStderr: (chunk) => stderr.push(new TextDecoder().decode(chunk)),
    onExit: (code, signal) => exits.push([code, signal]),
  });
  return {
    supervisor,
    timers,
    children,
    messages,
    states,
    violations,
    stderr,
    exits,
    starts: () => starts,
  };
}

/** Lets every quick start of the series fail, until the supervisor gives up. */
function failAll(
  ctx: ReturnType<typeof setup>,
  each: (child: NonNullable<ReturnType<typeof setup>['children'][number]>) => void = () =>
    undefined,
): void {
  ctx.supervisor.start();
  for (let i = 0; i < MAX_FAST_FAILURES; i += 1) {
    const child = ctx.children[i];
    if (child === undefined) throw new Error('no child');
    each(child);
    child.exit(1);
    ctx.timers.advance(BACKOFF_MAX_MS);
  }
}

describe('cleanCoreEnv', () => {
  it('keeps only allowlisted variables', () => {
    const env = cleanCoreEnv(
      {
        HOME: '/Users/x',
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        NODE_OPTIONS: '--require /tmp/evil.js',
        NODE_PATH: '/tmp',
        ELECTRON_RUN_AS_NODE: '1',
        AGENTLINK_OWNER_PASSPHRASE: 'secret',
        AGENTLINK_KEYSTORE_PASSPHRASE: 'secret',
        AGENTLINK_DESKTOP_PREVIEW: '1',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        LD_PRELOAD: '/tmp/x.so',
        UNDEFINED: undefined as unknown as string,
      },
      'darwin',
    );
    expect(env).toEqual({ HOME: '/Users/x', PATH: '/usr/bin', LANG: 'en_US.UTF-8' });
  });

  it('passes the AI app markers through, so the core still refuses an AI-started app (G-1)', () => {
    expect(
      cleanCoreEnv({ HOME: '/Users/x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'darwin'),
    ).toEqual({ HOME: '/Users/x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  });

  it('aiAppMarkerSet: any AI app marker with a value (Windows: any case)', () => {
    expect(aiAppMarkerSet({ HOME: '/Users/x' }, 'darwin')).toBe(false);
    expect(aiAppMarkerSet({ CLAUDECODE: '' }, 'darwin')).toBe(false);
    expect(aiAppMarkerSet({ CLAUDECODE: '1' }, 'darwin')).toBe(true);
    expect(aiAppMarkerSet({ GEMINI_CLI: '1' }, 'darwin')).toBe(true);
    expect(aiAppMarkerSet({ claudecode: '1' }, 'darwin')).toBe(false);
    expect(aiAppMarkerSet({ ClaudeCode: '1' }, 'win32')).toBe(true);
  });

  it('matches Windows names case-insensitively, keeping their spelling', () => {
    expect(
      cleanCoreEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', NODE_OPTIONS: 'x' }, 'win32'),
    ).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
    expect(cleanCoreEnv({ Path: '/usr/bin' }, 'darwin')).toEqual({});
  });
});

describe('coreSpawnEnv', () => {
  it('always sets the fixed log level and ignores the user-supplied one', () => {
    expect(coreSpawnEnv({ HOME: '/h', AGENTLINK_LOG: 'debug' }, 'darwin')).toEqual({
      HOME: '/h',
      AGENTLINK_LOG: 'warn',
    });
    expect(coreSpawnEnv({ agentlink_log: 'debug' }, 'win32')).toEqual({ AGENTLINK_LOG: 'warn' });
  });
});

describe('CoreSupervisor', () => {
  it('refuses relative paths', () => {
    const { spawn } = fakeSpawn();
    expect(
      () =>
        new CoreSupervisor({
          nodePath: 'node',
          hostScript: HOST,
          cwd: '/',
          env: {},
          platform: 'darwin',
          spawn,
          timers: new FakeTimers(),
          onMessage: () => undefined,
        }),
    ).toThrow();
  });

  it('spawns the bundled node with a fixed argv, fd 3 only and a clean env', () => {
    const { supervisor, children } = setup({ HOME: '/Users/x', NODE_OPTIONS: '--inspect' });
    supervisor.start();
    const child = children[0];
    expect(child?.command).toBe(NODE);
    expect(child?.args).toEqual([HOST]);
    expect(child?.options).toEqual({
      // WIN-STARTUP-LOG: the log level is fixed by the shell, never taken from the user's env.
      env: { HOME: '/Users/x', AGENTLINK_LOG: 'warn' },
      // WIN-DESK-1: 'overlapped' (the same as 'pipe' outside Windows) so the core can read and
      // write fd 3 at the same time on Windows.
      stdio: ['ignore', 'ignore', 'pipe', 'overlapped'],
      windowsHide: true,
      shell: false,
      detached: false,
      cwd: '/Users/x',
    });
    expect(supervisor.state).toBe('running');
  });

  it('passes valid messages on', () => {
    const { supervisor, children, messages } = setup();
    supervisor.start();
    children[0]?.stream.push(readyLine());
    expect(messages.map((m) => m.type)).toEqual(['ready']);
  });

  it('kills a core that breaks the protocol and starts a new one with backoff', () => {
    const { supervisor, children, messages, violations, timers, starts } = setup();
    supervisor.start();
    const first = children[0];
    first?.stream.push('{"v":1,"type":"run","cmd":"x"}\n');
    expect(messages).toEqual([]);
    expect(violations).toEqual(['message']);
    expect(first?.kills).toEqual(['SIGKILL']);
    first?.exit(1);
    expect(supervisor.state).toBe('waiting');
    timers.advance(BACKOFF_BASE_MS - 1);
    expect(children).toHaveLength(1);
    timers.advance(1);
    expect(children).toHaveLength(2);
    expect(starts()).toBe(2);
  });

  it('kills a core without an fd 3 stream', () => {
    const timers = new FakeTimers();
    const { spawn, children } = fakeSpawn();
    const supervisor = new CoreSupervisor({
      nodePath: NODE,
      hostScript: HOST,
      cwd: '/',
      env: {},
      platform: 'darwin',
      spawn: (c, a, o) => {
        const child = spawn(c, a, o);
        child.stdio[3] = null;
        return child;
      },
      timers,
      onMessage: () => undefined,
    });
    supervisor.start();
    expect(children[0]?.kills).toEqual(['SIGKILL']);
  });

  it('ignores messages from a core that is gone', () => {
    const { supervisor, children, messages } = setup();
    supervisor.start();
    const first = children[0];
    first?.exit(1);
    first?.stream.push(readyLine());
    expect(messages).toEqual([]);
  });

  it('backs off exponentially and gives up after repeated quick deaths', () => {
    const { supervisor, children, timers, states } = setup();
    supervisor.start();
    const delays: number[] = [];
    for (let i = 0; i < MAX_FAST_FAILURES - 1; i += 1) {
      const before = timers.time;
      children.at(-1)?.exit(1);
      const count = children.length;
      while (children.length === count) timers.advance(100);
      delays.push(timers.time - before);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000].map((d) => Math.min(d, BACKOFF_MAX_MS)));
    children.at(-1)?.exit(1);
    expect(supervisor.state).toBe('failed');
    expect(states.at(-1)).toBe('failed');
    timers.advance(10 * BACKOFF_MAX_MS);
    expect(children).toHaveLength(MAX_FAST_FAILURES);
    supervisor.retry();
    expect(children).toHaveLength(MAX_FAST_FAILURES + 1);
  });

  it.each(['no_owner', 'no_ids', 'only_removing', 'keychain', 'open'] as const)(
    'stops restarting when the core could not start (%s); retry starts it again',
    (reason) => {
      const { supervisor, children, timers, states, messages } = setup();
      supervisor.start();
      const child = children[0];
      child?.stream.push(`${JSON.stringify({ v: 1, type: 'stopped', reason })}\n`);
      expect(messages).toEqual([{ v: 1, type: 'stopped', reason }]);
      child?.exit(1);
      expect(supervisor.state).toBe('failed');
      expect(supervisor.failureReason).toBe(reason);
      expect(states.at(-1)).toBe('failed');
      timers.advance(10 * BACKOFF_MAX_MS);
      expect(children).toHaveLength(1);
      supervisor.retry();
      expect(children).toHaveLength(2);
      expect(supervisor.state).toBe('running');
      expect(supervisor.failureReason).toBeNull();
    },
  );

  it.each(['port', 'failed', 'fatal', 'signal'] as const)(
    'keeps the normal backoff after stopped "%s"',
    (reason) => {
      const { supervisor, children, timers } = setup();
      supervisor.start();
      children[0]?.stream.push(`${JSON.stringify({ v: 1, type: 'stopped', reason })}\n`);
      children[0]?.exit(1);
      expect(supervisor.state).toBe('waiting');
      expect(supervisor.failureReason).toBeNull();
      timers.advance(BACKOFF_BASE_MS);
      expect(children).toHaveLength(2);
    },
  );

  it('kills a core whose pipe closed', () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.stream.destroy();
    expect(children[0]?.kills).toEqual(['SIGKILL']);
  });

  it('resets the backoff after a stable run', () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    children[0]?.exit(1);
    timers.advance(BACKOFF_BASE_MS);
    timers.advance(STABLE_RUN_MS);
    const before = timers.time;
    children[1]?.exit(1);
    while (children.length === 2) timers.advance(100);
    expect(timers.time - before).toBe(BACKOFF_BASE_MS);
  });

  it('stops cleanly: shutdown on the pipe, then exit', async () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    const child = children[0];
    const stopped = supervisor.stop();
    expect(child?.stream.written).toEqual(['{"v":1,"type":"shutdown"}\n']);
    child?.exit(0);
    await stopped;
    expect(supervisor.state).toBe('stopped');
    expect(child?.kills).toEqual([]);
    timers.advance(60_000);
    expect(children).toHaveLength(1);
  });

  it('kills a core that does not exit: SIGTERM, then SIGKILL', async () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    const child = children[0];
    const stopped = supervisor.stop();
    timers.advance(SHUTDOWN_GRACE_MS);
    expect(child?.kills).toEqual(['SIGTERM']);
    timers.advance(KILL_GRACE_MS);
    expect(child?.kills).toEqual(['SIGTERM', 'SIGKILL']);
    child?.exit(1);
    await stopped;
    expect(supervisor.state).toBe('stopped');
  });

  it('stop while waiting cancels the restart', async () => {
    const { supervisor, children, timers } = setup();
    supervisor.start();
    children[0]?.exit(1);
    await supervisor.stop();
    timers.advance(BACKOFF_MAX_MS);
    expect(children).toHaveLength(1);
    expect(supervisor.state).toBe('stopped');
  });

  it('reads the core’s stderr and passes it on (it is never forwarded anywhere else)', () => {
    const { supervisor, children, stderr } = setup();
    supervisor.start();
    children[0]?.stderr.push('boom\n');
    expect(stderr).toEqual(['boom\n']);
  });

  it('reports every exit with its code and signal', () => {
    const { supervisor, children, exits } = setup();
    supervisor.start();
    children[0]?.exit(1, null);
    expect(exits).toEqual([[1, null]]);
  });

  it('failureKind: a start-failure reason', () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.stream.push('{"v":1,"type":"stopped","reason":"no_owner"}\n');
    children[0]?.exit(1);
    expect(supervisor.failureKind).toBe('no_owner');
  });

  it('failureKind: "exited" when no core of the series reached ready', () => {
    const ctx = setup();
    failAll(ctx);
    expect(ctx.supervisor.state).toBe('failed');
    expect(ctx.supervisor.failureReason).toBeNull();
    expect(ctx.supervisor.failureKind).toBe('exited');
  });

  it('failureKind: "port" when the last core said its port was taken', () => {
    const ctx = setup();
    failAll(ctx, (child) => child.stream.push('{"v":1,"type":"stopped","reason":"port"}\n'));
    expect(ctx.supervisor.failureKind).toBe('port');
  });

  it('failureKind: "retries" when a core had been ready but kept stopping', () => {
    const ctx = setup();
    failAll(ctx, (child) => child.stream.push(readyLine()));
    expect(ctx.supervisor.failureKind).toBe('retries');
  });

  it('failureKind: "exited" when the core cannot even be spawned', () => {
    const timers = new FakeTimers();
    const supervisor = new CoreSupervisor({
      nodePath: NODE,
      hostScript: HOST,
      cwd: '/',
      env: {},
      platform: 'darwin',
      spawn: () => {
        throw new Error('ENOENT');
      },
      timers,
      onMessage: () => undefined,
    });
    supervisor.start();
    for (let i = 0; i < MAX_FAST_FAILURES; i += 1) timers.advance(BACKOFF_MAX_MS);
    expect(supervisor.state).toBe('failed');
    expect(supervisor.failureKind).toBe('exited');
  });

  it('failureKind is null unless failed, and retry clears it', () => {
    const ctx = setup();
    expect(ctx.supervisor.failureKind).toBeNull();
    failAll(ctx);
    ctx.supervisor.retry();
    expect(ctx.supervisor.state).toBe('running');
    expect(ctx.supervisor.failureKind).toBeNull();
  });

  it('send works only while running', () => {
    const { supervisor, children } = setup();
    expect(supervisor.send({ v: 1, type: 'show', route: 'home' })).toBe(false);
    supervisor.start();
    expect(supervisor.send({ v: 1, type: 'show', route: 'home' })).toBe(true);
    expect(children[0]?.stream.written).toEqual(['{"v":1,"type":"show","route":"home"}\n']);
  });
});
