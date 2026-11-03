// R1: the `ui` host's process guards: a stray background rejection or exception is logged with a
// fixed code and the host keeps serving; only a problem fatal to the server itself, or a storm of
// them, ends the run.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { guardProcess, isServerFatal, type GuardLog } from './ui-lifecycle.js';

function setup(options: { max?: number } = {}) {
  const proc = new EventEmitter();
  const fatal: string[] = [];
  const logged: unknown[][] = [];
  let clock = 0;
  const log: GuardLog = {
    warn: (...args: unknown[]) => void logged.push(args),
  };
  const off = guardProcess({
    proc: proc as unknown as NodeJS.Process,
    log,
    onFatal: (reason) => fatal.push(reason),
    now: () => clock,
    ...(options.max === undefined ? {} : { maxStray: options.max }),
  });
  return {
    proc,
    fatal,
    logged,
    off,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('guardProcess (R1)', () => {
  it('a stray rejection is logged with a fixed code and the host keeps serving', () => {
    const s = setup();
    s.proc.emit(
      'unhandledRejection',
      Object.assign(new Error('secret /Users/x token=abc'), { code: 'ECONNRESET' }),
    );
    expect(s.fatal).toEqual([]);
    expect(JSON.stringify(s.logged)).toContain('ECONNRESET');
    expect(JSON.stringify(s.logged)).not.toMatch(/secret|token|Users/);
  });

  it('a rejection with no usable code logs "unknown" and never its text', () => {
    const s = setup();
    s.proc.emit('unhandledRejection', 'Bearer abc123');
    s.proc.emit('unhandledRejection', Object.assign(new Error('x'), { code: '/etc/passwd' }));
    expect(JSON.stringify(s.logged)).toContain('unknown');
    expect(JSON.stringify(s.logged)).not.toMatch(/abc123|passwd/);
    expect(s.fatal).toEqual([]);
  });

  it('an ordinary uncaught exception keeps serving', () => {
    const s = setup();
    s.proc.emit('uncaughtException', new Error('boom'));
    expect(s.fatal).toEqual([]);
  });

  it.each(['EADDRINUSE', 'ERR_SERVER_NOT_RUNNING', 'EMFILE'])(
    'an exception that is fatal to the server (%s) closes cleanly once',
    (code) => {
      const s = setup();
      s.proc.emit('uncaughtException', Object.assign(new Error('x'), { code }));
      s.proc.emit('uncaughtException', Object.assign(new Error('x'), { code }));
      expect(s.fatal).toEqual(['uncaught']);
    },
  );

  it('a storm of rejections within a minute ends the run as "rejections"', () => {
    const s = setup({ max: 3 });
    for (let i = 0; i < 3; i += 1) s.proc.emit('unhandledRejection', new Error('x'));
    expect(s.fatal).toEqual([]);
    s.proc.emit('unhandledRejection', new Error('x'));
    expect(s.fatal).toEqual(['rejections']);
  });

  it('rejections spread over time never add up', () => {
    const s = setup({ max: 3 });
    for (let i = 0; i < 10; i += 1) {
      s.proc.emit('unhandledRejection', new Error('x'));
      s.tick(30_000);
    }
    expect(s.fatal).toEqual([]);
  });

  it('a storm of exceptions ends the run as "uncaught"', () => {
    const s = setup({ max: 2 });
    for (let i = 0; i < 3; i += 1) s.proc.emit('uncaughtException', new Error('x'));
    expect(s.fatal).toEqual(['uncaught']);
  });

  it('unsubscribing removes both listeners', () => {
    const s = setup();
    s.off();
    expect(s.proc.listenerCount('unhandledRejection')).toBe(0);
    expect(s.proc.listenerCount('uncaughtException')).toBe(0);
  });

  it('isServerFatal knows only server-level codes', () => {
    expect(isServerFatal(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(isServerFatal(new Error('x'))).toBe(false);
    expect(isServerFatal('EADDRINUSE')).toBe(false);
    expect(isServerFatal(undefined)).toBe(false);
  });
});
