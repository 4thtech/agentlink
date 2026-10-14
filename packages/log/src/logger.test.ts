import { describe, expect, it } from 'vitest';
import { captureConsole, consoleSink } from './console.js';
import { createLogger, type Level } from './logger.js';
import { REDACTED } from './redact.js';

const HEX64 = 'cd34'.repeat(16);
const FIXED = new Date('2026-10-14T00:00:00.000Z');

function capture(level: Level = 'debug') {
  const lines: { level: Level; record: Record<string, unknown> }[] = [];
  const logger = createLogger({
    level,
    now: () => FIXED,
    sink: (at, line) => lines.push({ level: at, record: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes one JSON line per record with time, level, msg and fields', () => {
    const { logger, lines } = capture();
    logger.info('sent', { count: 2 });
    expect(lines).toEqual([
      {
        level: 'info',
        record: { time: '2026-10-14T00:00:00.000Z', level: 'info', msg: 'sent', count: 2 },
      },
    ]);
  });

  it('drops records below the threshold (default info)', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (_level, line) => lines.push(line) });
    logger.debug('hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
    expect(logger.isEnabled('debug')).toBe(false);
    expect(logger.isEnabled('error')).toBe(true);
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'redacts at level %s (debug included)',
    (level) => {
      const { logger, lines } = capture('debug');
      logger[level](`msg ${HEX64}`, { seed: 'x', note: HEX64 });
      expect(lines[0]?.record).toMatchObject({
        level,
        msg: `msg ${REDACTED}`,
        seed: REDACTED,
        note: REDACTED,
      });
    },
  );

  it('redacts child bindings and the logger name', () => {
    const lines: string[] = [];
    const logger = createLogger({ name: `svc ${HEX64}`, sink: (_l, line) => lines.push(line) });
    logger.child({ token: 'abc', peer: 'p1' }).info('hi');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      name: `svc ${REDACTED}`,
      token: REDACTED,
      peer: 'p1',
    });
  });

  it('does not let fields overwrite time, level, name or msg', () => {
    const { logger, lines } = capture();
    logger.warn('real', { msg: 'fake', level: 'error' });
    expect(lines[0]?.record).toMatchObject({
      level: 'warn',
      msg: 'real',
      _msg: 'fake',
      _level: 'error',
    });
  });

  it('accepts an Error as fields and scrubs it', () => {
    const { logger, lines } = capture();
    logger.error('failed', new Error(`boom ${HEX64}`));
    const err = lines[0]?.record.err as Record<string, unknown>;
    expect(err.message).toBe(`boom ${REDACTED}`);
    expect(JSON.stringify(lines)).not.toContain(HEX64);
  });

  it('never falls back to raw input when fields cannot be read', () => {
    const { logger, lines } = capture();
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(HEX64);
        },
      },
    );
    logger.info('x', hostile);
    expect(lines[0]?.record.msg).toBe('[Unloggable record]');
    expect(JSON.stringify(lines)).not.toContain(HEX64);
  });

  it('survives a sink that throws', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => logger.error('x')).not.toThrow();
  });

  it('rejects an unknown level', () => {
    expect(() => createLogger({ level: 'trace' as Level })).toThrow(TypeError);
  });
});

describe('consoleSink', () => {
  it('uses the console method for the level', () => {
    const calls: string[] = [];
    const restore = captureConsole((method, data) => calls.push(`${method}:${String(data[0])}`));
    try {
      const logger = createLogger({ level: 'debug', sink: consoleSink() });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
    } finally {
      restore();
    }
    expect(calls.map((call) => call.split(':')[0])).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('writes every level to the error stream with { stderr: true } (stdio MCP servers)', () => {
    const methods: string[] = [];
    const restore = captureConsole((method) => methods.push(method));
    try {
      const logger = createLogger({ level: 'debug', sink: consoleSink({ stderr: true }) });
      logger.debug('d');
      logger.info('i');
    } finally {
      restore();
    }
    expect(methods).toEqual(['error', 'error']);
  });
});
