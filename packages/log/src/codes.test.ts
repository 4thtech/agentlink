// The fixed-code allowlist (M1-7g-d; 04 §3.4, I-7): a `code` field is written as is only when its
// value is a code the caller listed (or an HTTP status or system error code, as before). Every other
// value is redacted, whatever its shape.
import { describe, expect, it } from 'vitest';
import { createLogger, type Logger, type LoggerOptions } from './logger.js';
import { REDACTED } from './redact.js';

function capture(options: Omit<LoggerOptions, 'sink'> = {}) {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    ...options,
    sink: (_at, line) => records.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, records };
}

describe('the fixed-code allowlist', () => {
  it('a listed code reaches the log as is', () => {
    const { logger, records } = capture({ codes: ['proof_mismatch'] });
    logger.warn('proof envelope does not match', { code: 'proof_mismatch' });
    expect(records[0]!.code).toBe('proof_mismatch');
  });

  it('an unlisted code is not logged', () => {
    const { logger, records } = capture({ codes: ['proof_mismatch'] });
    logger.warn('x', { code: 'proof_unchecked' });
    logger.warn('x', { code: 'something the body said' });
    expect(records.map((r) => r.code)).toEqual([REDACTED, REDACTED]);
    expect(JSON.stringify(records)).not.toContain('proof_unchecked');
  });

  it('without a list no fixed code is logged (the default stays closed)', () => {
    const { logger, records } = capture();
    logger.warn('x', { code: 'proof_mismatch' });
    expect(records[0]!.code).toBe(REDACTED);
  });

  it('HTTP status and system error codes stay as before', () => {
    const { logger, records } = capture({ codes: ['proof_mismatch'] });
    logger.warn('x', { code: 503 });
    logger.warn('x', { code: 'ECONNREFUSED' });
    expect(records.map((r) => r.code)).toEqual([503, 'ECONNREFUSED']);
  });

  it('only the top-level `code` field is matched; nested and other code-named fields are not', () => {
    const { logger, records } = capture({ codes: ['proof_mismatch'] });
    logger.warn('x', { reason: { code: 'proof_mismatch' }, errorCode: 'proof_mismatch' });
    const r = records[0]!;
    expect(r.errorCode).toBe(REDACTED);
    expect((r.reason as { code: unknown }).code).toBe(REDACTED);
  });

  it('a non-string value equal in text to a listed code is not kept', () => {
    const { logger, records } = capture({ codes: ['proof_mismatch'] });
    logger.warn('x', { code: ['proof_mismatch'] });
    logger.warn('x', { code: { toString: () => 'proof_mismatch' } });
    expect(records.map((r) => r.code)).toEqual([REDACTED, REDACTED]);
  });

  it('a listed code in bindings is kept; fields override bindings', () => {
    const { logger, records } = capture({ codes: ['a_code', 'b_code'] });
    logger.child({ code: 'a_code' }).info('x');
    logger.child({ code: 'a_code' }).info('x', { code: 'not_listed' });
    expect(records.map((r) => r.code)).toEqual(['a_code', REDACTED]);
  });

  it('withCodes adds codes; children keep them; the parent is unchanged', () => {
    const { logger, records } = capture({ codes: ['a_code'] });
    const more: Logger = logger.withCodes(['b_code']);
    more.info('x', { code: 'a_code' });
    more.info('x', { code: 'b_code' });
    more.child({ part: 1 }).info('x', { code: 'b_code' });
    logger.info('x', { code: 'b_code' });
    expect(records.map((r) => r.code)).toEqual(['a_code', 'b_code', 'b_code', REDACTED]);
  });

  it('refuses a code that is not a fixed identifier or that redaction would change', () => {
    const bad = [
      '',
      'has space',
      'proof-mismatch',
      'Mixed_Case',
      '_leading',
      'trailing_',
      'a'.repeat(65),
      'cd34'.repeat(16), // 64 hex digits: secret-shaped
      'ABCDEFGHIJKLMNOPQRSTUVWX', // the recovery-code shape
    ];
    for (const code of bad) {
      expect(() => createLogger({ codes: [code] })).toThrow(TypeError);
      expect(() => createLogger().withCodes([code])).toThrow(TypeError);
    }
    expect(() => createLogger({ codes: [42 as unknown as string] })).toThrow(TypeError);
  });

  it('accepts lower and upper snake case codes', () => {
    const { logger, records } = capture({ codes: ['proof_parent_mismatch', 'APPROVAL_VOID'] });
    logger.info('x', { code: 'proof_parent_mismatch' });
    logger.info('x', { code: 'APPROVAL_VOID' });
    expect(records.map((r) => r.code)).toEqual(['proof_parent_mismatch', 'APPROVAL_VOID']);
  });
});
