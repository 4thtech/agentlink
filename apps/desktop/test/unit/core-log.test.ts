// The core's stderr log (src/main/core-log.ts): a capped in-memory ring of the last lines and a
// size-capped, rotating 0600 file in the per-user log folder. Every line is redacted first: links,
// localhost addresses, token parameters and long hex / base64 runs never reach memory or disk.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_LOG_FILE,
  CORE_LOG_OLD_FILE,
  MAX_LINE_CHARS,
  RING_LINES,
  CoreLog,
  logDir,
  redactLine,
} from '../../src/main/core-log.js';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-core-log-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = 'A'.repeat(43);

describe('redactLine', () => {
  it.each([
    [`ready at http://localhost:4567/?t=${TOKEN}`, 'http'],
    [`see https://agentlink.4thtech.io/i#2.${'b'.repeat(40)}`, 'agentlink.4thtech.io'],
    ['listening on localhost:4567/first-run', 'localhost:4567'],
    ['link 127.0.0.1:4567/x', '127.0.0.1:4567'],
    [`token t=${'x'.repeat(10)}`, 'x'.repeat(10)],
    [`hex ${'ab12'.repeat(8)}`, 'ab12ab12'],
    [`b64 ${'Zm9vYmFy'.repeat(5)}==`, 'Zm9vYmFy'],
    [`b64url ${'a_b-'.repeat(9)}`, 'a_b-a_b-'],
    [`std b64 with slashes ab3/${'Q'.repeat(20)}/Rk9P+${'z'.repeat(10)}=`, 'QQQQQQQQ'],
    ['file:///Users/x/.agentlink/store', 'file://'],
  ])('removes secrets from %j', (line, secret) => {
    const out = redactLine(line);
    expect(out).not.toContain(secret);
  });

  it('keeps plain words and short numbers', () => {
    expect(redactLine('Error: keychain item not found (code 44)')).toBe(
      'Error: keychain item not found (code 44)',
    );
    expect(redactLine('    at start (desktop-host.js:12:34)')).toBe(
      '    at start (desktop-host.js:12:34)',
    );
  });

  it('removes control characters and caps the length', () => {
    expect(redactLine('a\u001b[31mred\u0007')).toBe('a?[31mred?');
    expect(redactLine('word '.repeat(1000)).length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
  });
});

describe('logDir', () => {
  it('is ~/Library/Logs/AgentLink on macOS', () => {
    expect(logDir('darwin', '/Users/x', {})).toBe('/Users/x/Library/Logs/AgentLink');
  });
  it('is %LOCALAPPDATA%\\AgentLink\\logs on Windows', () => {
    expect(logDir('win32', 'C:\\Users\\x', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      'C:\\Users\\x\\AppData\\Local\\AgentLink\\logs',
    );
    expect(logDir('win32', 'C:\\Users\\x', {})).toBe(
      'C:\\Users\\x\\AppData\\Local\\AgentLink\\logs',
    );
  });
  it('uses the XDG state folder on Linux', () => {
    expect(logDir('linux', '/home/x', {})).toBe('/home/x/.local/state/agentlink/logs');
    expect(logDir('linux', '/home/x', { XDG_STATE_HOME: '/s' })).toBe('/s/agentlink/logs');
    expect(logDir('linux', '/home/x', { XDG_STATE_HOME: 'relative' })).toBe(
      '/home/x/.local/state/agentlink/logs',
    );
  });
});

describe('CoreLog', () => {
  it('keeps the last RING_LINES redacted lines in memory, split across chunks', () => {
    const log = new CoreLog({ dir: temp() });
    log.write(new TextEncoder().encode('first li'));
    log.write('ne\nsecond ');
    log.write(`http://localhost:1/?t=${TOKEN}\n`);
    expect(log.lines()).toEqual(['first line', 'second [link removed]']);
    for (let i = 0; i < RING_LINES + 50; i += 1) log.write(`line ${i}\n`);
    expect(log.lines()).toHaveLength(RING_LINES);
    expect(log.lines().at(-1)).toBe(`line ${RING_LINES + 49}`);
  });

  it('caps a line that never ends', () => {
    const log = new CoreLog({ dir: temp() });
    log.write('x '.repeat(MAX_LINE_CHARS * 4));
    log.write('\n');
    for (const line of log.lines()) expect(line.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
  });

  it('writes the redacted lines to core.log with mode 0600 in a 0700 folder', () => {
    const dir = join(temp(), 'Logs', 'AgentLink');
    const log = new CoreLog({ dir });
    log.note('core started');
    log.write(`oops ${'f'.repeat(64)}\n`);
    const text = readFileSync(join(dir, CORE_LOG_FILE), 'utf8');
    expect(text).toMatch(/core started\n/);
    expect(text).toMatch(/oops \[removed\]\n/);
    expect(text).not.toContain('ffff');
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, CORE_LOG_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('tightens an existing log file to 0600', () => {
    if (process.platform === 'win32') return;
    const dir = temp();
    writeFileSync(join(dir, CORE_LOG_FILE), 'old\n');
    chmodSync(join(dir, CORE_LOG_FILE), 0o644);
    new CoreLog({ dir }).note('x');
    expect(statSync(join(dir, CORE_LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('rotates at the size cap and keeps one old file', () => {
    const dir = temp();
    const log = new CoreLog({ dir, maxBytes: 200 });
    for (let i = 0; i < 40; i += 1) log.write(`line number ${i}\n`);
    expect(statSync(join(dir, CORE_LOG_FILE)).size).toBeLessThanOrEqual(200);
    expect(statSync(join(dir, CORE_LOG_OLD_FILE)).size).toBeLessThanOrEqual(200);
    expect(readFileSync(join(dir, CORE_LOG_FILE), 'utf8')).toContain('line number 39');
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, CORE_LOG_OLD_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it('never throws when the folder cannot be written; memory still works', () => {
    const dir = temp();
    writeFileSync(join(dir, 'file'), 'x');
    const log = new CoreLog({ dir: join(dir, 'file', 'sub') });
    expect(() => log.write('still here\n')).not.toThrow();
    expect(log.lines()).toEqual(['still here']);
  });
});
