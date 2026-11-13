// N7 (PLAN-NOTIFY §3.5; S2): while the desktop app runs, it owns the OS notifications. Its core
// marks that in `~/.agentlink/desktop-alerts.json` ({v, pid}; 0600), and `agentlink mcp` then
// shows no osascript / notify-send alert (no double alerts). The browser/CLI app keeps today's alert
// and its switch.
import { chmod, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_ALERTS_FILE,
  desktopOwnsAlerts,
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

const file = (): string => join(home, '.agentlink', DESKTOP_ALERTS_FILE);
const alive = (pid: number): boolean => pid === process.pid;

describe('the desktop alerts record', () => {
  it('written 0600 with the pid only; read back as owning while that process lives', async () => {
    await writeDesktopAlertsRecord(home, process.pid);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ v: 1, pid: process.pid });
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      expect((await stat(file())).mode & 0o777).toBe(0o600);
    }
    expect(await desktopOwnsAlerts(home, alive)).toBe(true);
  });

  it('a record of a process that is gone does not count', async () => {
    await writeDesktopAlertsRecord(home, 999_999);
    expect(await desktopOwnsAlerts(home, alive)).toBe(false);
  });

  it('removed only by its own process', async () => {
    await writeDesktopAlertsRecord(home, process.pid);
    await removeDesktopAlertsRecord(home, 1234);
    expect(await desktopOwnsAlerts(home, alive)).toBe(true);
    await removeDesktopAlertsRecord(home, process.pid);
    expect(await desktopOwnsAlerts(home, alive)).toBe(false);
  });

  it('a malformed, oversized, linked or shared record does not count', async () => {
    await mkdir(join(home, '.agentlink'), { recursive: true, mode: 0o700 });
    for (const text of [
      '{}',
      '{"v":1,"pid":"1"}',
      `{"v":1,"pid":${process.pid},"x":1}`,
      'x'.repeat(600),
    ]) {
      await writeFile(file(), text, { mode: 0o600 });
      expect(await desktopOwnsAlerts(home, alive)).toBe(false);
    }
    if (process.platform !== 'win32') {
      await writeFile(file(), JSON.stringify({ v: 1, pid: process.pid }), { mode: 0o600 });
      await chmod(file(), 0o644);
      expect(await desktopOwnsAlerts(home, alive)).toBe(false);
      await rm(file());
      const real = join(home, 'real.json');
      await writeFile(real, JSON.stringify({ v: 1, pid: process.pid }), { mode: 0o600 });
      await symlink(real, file());
      expect(await desktopOwnsAlerts(home, alive)).toBe(false);
    }
  });
});

describe('osApprovalAlertsOn (agentlink mcp)', () => {
  it('no osascript / notify-send while the desktop app owns notifications', async () => {
    await writeDesktopAlertsRecord(home, process.pid);
    expect(await osApprovalAlertsOn(home, () => Promise.resolve(true), alive)).toBe(false);
  });

  it('the browser/CLI app keeps today’s alert and honours its switch', async () => {
    expect(await osApprovalAlertsOn(home, () => Promise.resolve(true), alive)).toBe(true);
    expect(await osApprovalAlertsOn(home, () => Promise.resolve(false), alive)).toBe(false);
  });
});
