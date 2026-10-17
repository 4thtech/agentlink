import { describe, expect, it } from 'vitest';
import { createLogger } from '@agentlink/log';
import { cliLogLevel } from './log-level.js';

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

  it('AGENTLINK_LOG turns more on', () => {
    expect(cliLogLevel({ AGENTLINK_LOG: 'info' })).toBe('info');
    expect(cliLogLevel({ AGENTLINK_LOG: ' DEBUG ' })).toBe('debug');
    expect(cliLogLevel({ AGENTLINK_LOG: 'error' })).toBe('error');
  });
});
