// APP-CONTINUITY (08 §1 "One AgentLink, browser or app"): before the Mac app's core first reads
// keychain items the browser version saved, the app says once what macOS will ask: the dialog
// names "node" and wants the Mac login password (never the master code); choose Always Allow.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KEYCHAIN_NOTICE_FILE,
  keychainNoticeDialog,
  markKeychainNoticeShown,
  needsKeychainNotice,
} from '../../src/main/keychain-notice.js';

let home = '';
let state = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'al-kc-home-'));
  state = join(home, 'state');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const input = (platform = 'darwin') => ({
  platform,
  homeDir: home,
  stateDir: state,
  exists: (p: string) => existsSync(p),
});

describe('the one-time keychain notice', () => {
  it('only on a Mac where AgentLink was set up before the app, and only once', async () => {
    expect(needsKeychainNotice(input())).toBe(false);
    await mkdir(join(home, '.agentlink'));
    expect(needsKeychainNotice(input())).toBe(false);
    await writeFile(join(home, '.agentlink', 'app.json'), '{}');
    expect(needsKeychainNotice(input())).toBe(true);
    expect(needsKeychainNotice(input('win32'))).toBe(false);
    expect(needsKeychainNotice({ ...input(), stateDir: '' })).toBe(false);
    markKeychainNoticeShown(state);
    expect(existsSync(join(state, KEYCHAIN_NOTICE_FILE))).toBe(true);
    expect(needsKeychainNotice(input())).toBe(false);
  });

  it('says "node", the Mac login password, never the master code, and Always Allow', () => {
    const d = keychainNoticeDialog();
    const text = `${d.message} ${d.detail ?? ''}`;
    expect(text).toMatch(/node/);
    expect(text).toMatch(/Mac login password/);
    expect(text).toMatch(/never your master code/);
    expect(text).toMatch(/Always Allow/);
    expect(text).not.toMatch(/wallet|seed phrase|\bgas\b|transaction/i);
    expect(d.buttons).toEqual(['Continue']);
  });
});
