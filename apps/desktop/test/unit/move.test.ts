// Location refusal (src/main/move.ts; plan Decision 2 "Translocation", Fable M3).
import { describe, expect, it } from 'vitest';
import {
  MOVE_COPY,
  appRoot,
  ensureGoodLocation,
  locationProblem,
  type LocationInput,
} from '../../src/main/move.js';
import { FakeApp, FakeDialog } from './fakes.js';

const MAC_TMP = '/var/folders/ab/xyz/T';
const mac = (execPath: string, writable = true): LocationInput => ({
  platform: 'darwin',
  execPath,
  tmpDir: MAC_TMP,
  writable: () => writable,
});
const win = (execPath: string, writable = true): LocationInput => ({
  platform: 'win32',
  execPath,
  tmpDir: 'C:\\Users\\x\\AppData\\Local\\Temp',
  writable: () => writable,
});
const IN_APPS = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';
const TRANSLOCATED =
  '/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/AgentLink.app/Contents/MacOS/AgentLink';

describe('locationProblem', () => {
  it('finds the bundle root', () => {
    expect(appRoot(IN_APPS, 'darwin')).toBe('/Applications/AgentLink.app');
    expect(
      appRoot('C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink\\AgentLink.exe', 'win32'),
    ).toBe('C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink');
  });

  it('accepts Applications and the per-user install', () => {
    expect(locationProblem(mac(IN_APPS))).toBeNull();
    expect(
      locationProblem(mac('/Users/x/Applications/AgentLink.app/Contents/MacOS/AgentLink')),
    ).toBeNull();
    expect(
      locationProblem(win('C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink\\AgentLink.exe')),
    ).toBeNull();
  });

  it('accepts an Applications folder this user cannot write (standard user)', () => {
    expect(locationProblem(mac(IN_APPS, false))).toBeNull();
    expect(
      locationProblem(mac('/Users/x/Applications/AgentLink.app/Contents/MacOS/AgentLink', false)),
    ).toBeNull();
    expect(
      locationProblem(mac('/Applications/Sub/AgentLink.app/Contents/MacOS/AgentLink', false)),
    ).toBe('read_only');
  });

  it('refuses a translocated app', () => {
    expect(locationProblem(mac(TRANSLOCATED))).toBe('translocated');
  });

  it('refuses a read-only disk image and a read-only folder', () => {
    expect(
      locationProblem(mac('/Volumes/AgentLink/AgentLink.app/Contents/MacOS/AgentLink', false)),
    ).toBe('read_only');
    expect(
      locationProblem(mac('/Users/x/Downloads/AgentLink.app/Contents/MacOS/AgentLink', false)),
    ).toBe('read_only');
    expect(locationProblem(win('C:\\Program Files\\AgentLink\\AgentLink.exe', false))).toBe(
      'read_only',
    );
  });

  it('refuses a temporary folder (a zip opened in place)', () => {
    expect(
      locationProblem(
        win('C:\\Users\\x\\AppData\\Local\\Temp\\Temp1_AgentLink.zip\\AgentLink.exe'),
      ),
    ).toBe('temporary');
    expect(locationProblem(win('c:\\users\\X\\appdata\\local\\temp\\a\\AgentLink.exe'))).toBe(
      'temporary',
    );
    expect(locationProblem(mac(`${MAC_TMP}/x/AgentLink.app/Contents/MacOS/AgentLink`))).toBe(
      'temporary',
    );
    expect(
      locationProblem(mac(`/private${MAC_TMP}/x/AgentLink.app/Contents/MacOS/AgentLink`)),
    ).toBe('temporary');
  });
});

describe('ensureGoodLocation', () => {
  it('does nothing in a good location', async () => {
    const dialog = new FakeDialog();
    expect(await ensureGoodLocation(mac(IN_APPS), new FakeApp(), dialog)).toBe('ok');
    expect(dialog.shown).toEqual([]);
  });

  it('macOS: offers Move to Applications and moves', async () => {
    const dialog = new FakeDialog();
    const app = new FakeApp();
    dialog.responses = [0];
    expect(await ensureGoodLocation(mac(TRANSLOCATED), app, dialog)).toBe('moved');
    expect(app.moveCalls).toBe(1);
    expect(dialog.shown[0]?.buttons).toEqual([MOVE_COPY.move, MOVE_COPY.quit]);
  });

  it('macOS: Quit does not move', async () => {
    const dialog = new FakeDialog();
    const app = new FakeApp();
    dialog.responses = [1];
    expect(await ensureGoodLocation(mac(TRANSLOCATED), app, dialog)).toBe('quit');
    expect(app.moveCalls).toBe(0);
  });

  it('macOS: a failed move explains and quits', async () => {
    const dialog = new FakeDialog();
    const app = new FakeApp();
    app.moveResult = false;
    dialog.responses = [0, 0];
    expect(await ensureGoodLocation(mac(TRANSLOCATED), app, dialog)).toBe('quit');
    expect(dialog.shown[1]?.message).toBe(MOVE_COPY.failedMessage);
  });

  it('Windows: explains and quits', async () => {
    const dialog = new FakeDialog();
    expect(
      await ensureGoodLocation(
        win('C:\\Users\\x\\AppData\\Local\\Temp\\z\\AgentLink.exe'),
        new FakeApp(),
        dialog,
      ),
    ).toBe('quit');
    expect(dialog.shown[0]?.buttons).toEqual([MOVE_COPY.quit]);
  });

  it('the copy avoids the forbidden vocabulary (11 §5)', () => {
    const text = Object.values(MOVE_COPY).join(' ').toLowerCase();
    for (const word of ['wallet', 'gas', 'seed phrase', 'transaction']) {
      expect(text).not.toContain(word);
    }
  });
});
