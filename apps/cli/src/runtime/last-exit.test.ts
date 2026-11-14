// R1: the last-exit record: ~/.agentlink/last-exit.json, mode 0600, only a fixed reason code, a time
// and the version. Temp HOME only.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAST_EXIT_FILE, LAST_EXIT_REASONS, readLastExit, writeLastExit } from './last-exit.js';

const POSIX = process.platform !== 'win32';
let home = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-r1-last-exit-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const file = (): string => join(home, '.agentlink', LAST_EXIT_FILE);

describe('the last-exit record (R1)', () => {
  it('is written 0600 with only v, at, version and a fixed reason', async () => {
    await writeLastExit(home, { reason: 'ctrl_c', version: '1.2.3', at: 1_800_000_000 });
    if (POSIX) expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      v: 1,
      at: 1_800_000_000,
      version: '1.2.3',
      reason: 'ctrl_c',
    });
    expect(await readLastExit(home)).toEqual({
      at: 1_800_000_000,
      version: '1.2.3',
      reason: 'ctrl_c',
    });
  });

  it('is overwritten by the next exit and leaves no temporary file', async () => {
    await writeLastExit(home, { reason: 'ctrl_c', version: '1.0.0', at: 1 });
    await writeLastExit(home, { reason: 'idle', version: '1.0.0', at: 2 });
    expect((await readLastExit(home))?.reason).toBe('idle');
    expect((await readdir(join(home, '.agentlink'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('names a closed set of reasons, all plain codes', () => {
    expect([...LAST_EXIT_REASONS].sort()).toEqual(
      [
        'ctrl_c',
        'idle',
        // APP-CONTINUITY: the desktop app took over this terminal host.
        'moved_to_app',
        'rejections',
        'sighup',
        'sigterm',
        'start_failed',
        'start_keychain',
        'start_no_ids',
        'start_no_owner',
        'start_open',
        'start_port',
        'start_removing',
        'uncaught',
      ].sort(),
    );
  });

  it('ignores a record with an unknown reason, extra fields, bad JSON or a bad version', async () => {
    await mkdir(join(home, '.agentlink'), { recursive: true, mode: 0o700 });
    for (const text of [
      '{"v":1,"at":1,"version":"1.0.0","reason":"Error: /Users/x/secret"}',
      '{"v":1,"at":1,"version":"1.0.0","reason":"idle","name":"Tali"}',
      '{"v":1,"at":1,"version":"/Users/x","reason":"idle"}',
      '{"v":2,"at":1,"version":"1.0.0","reason":"idle"}',
      'not json',
    ]) {
      await writeFile(file(), text, { mode: 0o600 });
      await chmod(file(), 0o600);
      expect(await readLastExit(home)).toBeUndefined();
    }
  });

  it('never throws: an unwritable home just means no record', async () => {
    const blocker = join(home, 'blocker');
    await writeFile(blocker, 'x');
    await expect(
      writeLastExit(blocker, { reason: 'idle', version: '1.0.0', at: 1 }),
    ).resolves.toBeUndefined();
    expect(await readLastExit(blocker)).toBeUndefined();
  });

  it('a missing file reads as undefined', async () => {
    expect(await readLastExit(home)).toBeUndefined();
  });
});
