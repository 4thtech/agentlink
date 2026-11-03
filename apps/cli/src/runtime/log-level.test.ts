import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@4thtech-io/log';
import { cliLogger, cliLogLevel } from './log-level.js';

describe('CLI log level (M1-9y)', () => {
  it('defaults to warn: no structured info lines on the terminal', () => {
    expect(cliLogLevel({})).toBe('warn');
    expect(cliLogLevel({ AGENTLINK_LOG: 'nonsense' })).toBe('warn');
    const lines: string[] = [];
    const log = createLogger({
      name: 'cli',
      level: cliLogLevel({}),
      sink: (_level, line) => lines.push(line),
    });
    log.info('identity created', { keyEpoch: 0 });
    log.warn('careful');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('careful');
  });

  it('the interactive logger prints nothing unless AGENTLINK_LOG asks (W8-FEEDBACK-S1)', () => {
    const written: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
    try {
      cliLogger('cli', {}).warn('drop invite upload failed', { status: 500 });
      cliLogger('cli', { AGENTLINK_LOG: 'nonsense' }).error('x');
      expect(written).toEqual([]);
      cliLogger('cli', { AGENTLINK_LOG: 'warn' }).warn('drop invite upload failed');
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('drop invite upload failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('AGENTLINK_LOG turns more on', () => {
    expect(cliLogLevel({ AGENTLINK_LOG: 'info' })).toBe('info');
    expect(cliLogLevel({ AGENTLINK_LOG: ' DEBUG ' })).toBe('debug');
    expect(cliLogLevel({ AGENTLINK_LOG: 'error' })).toBe('error');
  });
});
