// N7 (PLAN-NOTIFY §3.5; S2): while the desktop app runs, it owns the OS notifications for its open
// ID. Its core marks that in `~/.agentlink/desktop-alerts.json` ({v, pid, started, at, id}; 0600),
// and `agentlink mcp` for that ID then shows no osascript / notify-send alert (no double alerts).
// Every other ID keeps its alert (IR-N7-1 L-5); a stale record never counts (L-2). The browser/CLI
// app keeps today's alert and its switch.
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_ALERTS_FILE,
  RECORD_LEASE_MS,
  desktopAlertsFor,
  osApprovalAlertsOn,
  removeDesktopAlertsRecord,
  writeDesktopAlertsRecord,
} from './desktop-alerts-record.js';

let home = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'al-n7-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const T = 1_800_000_000_000;
const BOOT = T - 3_600_000;
const file = (): string => join(home, '.agentlink', DESKTOP_ALERTS_FILE);
const checks = (over: { now?: number; boot?: number; alive?: number[] } = {}) => ({
  alive: (pid: number) => (over.alive ?? [process.pid]).includes(pid),
  now: () => over.now ?? T,
  bootedAt: () => over.boot ?? BOOT,
});
const write = (id = 'default', pid = process.pid, started = BOOT + 1000, at = T) =>
  writeDesktopAlertsRecord(home, { pid, started, id }, () => at);

describe('the desktop alerts record', () => {
  it('written 0600 with the pid, start time, write time and ID only', async () => {
    await write();
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      v: 1,
      pid: process.pid,
      started: BOOT + 1000,
      at: T,
      id: 'default',
    });
    if (process.platform !== 'win32') expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(true);
  });

  it('IR-N7-1 L-5: it counts only for the ID the desktop app alerts for', async () => {
    await write('work');
    expect(await desktopAlertsFor(home, 'work', checks())).toBe(true);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
  });

  it('IR-N7-1 L-2: a stale record never counts, even with a live (reused) pid', async () => {
    // Not renewed within the lease (a hard kill: the pid may now be someone else's).
    await write('default', process.pid, BOOT + 1000, T - RECORD_LEASE_MS - 1);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    // Its process started before this boot (power loss).
    await write('default', process.pid, BOOT - 10 * 60_000, T);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    // Written before its own start (not a real record).
    await write('default', process.pid, T, T - 5_000);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    // The process is gone.
    await write('default', 999_999);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    // Renewed and alive: counts.
    await write('default', process.pid, BOOT + 1000, T - RECORD_LEASE_MS + 1000);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(true);
  });

  it('refuses to write an invalid ID', async () => {
    await expect(write('../x')).rejects.toThrow();
  });

  it('removed only by its own process', async () => {
    await write();
    await removeDesktopAlertsRecord(home, 1234);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(true);
    await removeDesktopAlertsRecord(home, process.pid);
    expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
  });

  it('a malformed, oversized, linked or shared record does not count', async () => {
    await mkdir(join(home, '.agentlink'), { recursive: true, mode: 0o700 });
    const good = { v: 1, pid: process.pid, started: BOOT + 1000, at: T, id: 'default' };
    for (const text of [
      '{}',
      JSON.stringify({ v: 1, pid: process.pid }),
      JSON.stringify({ ...good, pid: '1' }),
      JSON.stringify({ ...good, x: 1 }),
      JSON.stringify({ ...good, id: 'Default!' }),
      'x'.repeat(600),
    ]) {
      await writeFile(file(), text, { mode: 0o600 });
      expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    }
    if (process.platform !== 'win32') {
      await writeFile(file(), JSON.stringify(good), { mode: 0o600 });
      await chmod(file(), 0o644);
      expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
      await rm(file());
      const real = join(home, 'real.json');
      await writeFile(real, JSON.stringify(good), { mode: 0o600 });
      await symlink(real, file());
      expect(await desktopAlertsFor(home, 'default', checks())).toBe(false);
    }
  });
});

describe('osApprovalAlertsOn (agentlink mcp)', () => {
  it('no osascript / notify-send for the ID the desktop app alerts for', async () => {
    await write('default');
    expect(await osApprovalAlertsOn(home, 'default', () => Promise.resolve(true), checks())).toBe(
      false,
    );
  });

  it('IR-N7-1 L-5: another ID still alerts while the desktop app runs', async () => {
    await write('default');
    expect(await osApprovalAlertsOn(home, 'work', () => Promise.resolve(true), checks())).toBe(
      true,
    );
  });

  it('the browser/CLI app keeps today’s alert and honours its switch', async () => {
    expect(await osApprovalAlertsOn(home, 'default', () => Promise.resolve(true), checks())).toBe(
      true,
    );
    expect(await osApprovalAlertsOn(home, 'default', () => Promise.resolve(false), checks())).toBe(
      false,
    );
  });
});
