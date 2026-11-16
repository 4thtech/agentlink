// TRAY-TOGGLE (D-155; 08 §1 UI settings): the two menu bar widget switches the app keeps in
// ui-settings, `menuBarIcon` and `widgetPreviews`. Booleans only; absent = on (older files read as
// the defaults); any other key or value is refused by the one strict reader.
import { describe, expect, it } from 'vitest';
import {
  UI_SETTINGS_KEYS,
  mergeUiSettings,
  readUiSettings,
  trayPrefsInForce,
} from './ui-contract/ui-settings.js';

describe('ui-settings: the menu bar widget switches (TRAY-TOGGLE)', () => {
  it('allowlists exactly the two new keys next to the existing ones', () => {
    expect(UI_SETTINGS_KEYS).toEqual([
      'underTheHood',
      'menuExpanded',
      'kept',
      'notify',
      'menuBarIcon',
      'widgetPreviews',
    ]);
  });

  it('reads each switch as a boolean, alone (a PUT) or with every other key', () => {
    expect(readUiSettings({ menuBarIcon: false }, 1)).toEqual({ menuBarIcon: false });
    expect(readUiSettings({ widgetPreviews: false }, 1)).toEqual({ widgetPreviews: false });
    expect(readUiSettings({ menuBarIcon: true, widgetPreviews: true }, 1)).toEqual({
      menuBarIcon: true,
      widgetPreviews: true,
    });
    const all = {
      underTheHood: true,
      menuExpanded: false,
      kept: {},
      notify: { approvals: true },
      menuBarIcon: false,
      widgetPreviews: false,
    };
    expect(readUiSettings(all)).toEqual(all);
  });

  it('refuses wrong types and unknown keys', () => {
    for (const bad of ['false', 'off', 0, 1, null, [], {}, undefined]) {
      expect(readUiSettings({ menuBarIcon: bad }, 1), `menuBarIcon ${String(bad)}`).toBeUndefined();
      expect(
        readUiSettings({ widgetPreviews: bad }, 1),
        `widgetPreviews ${String(bad)}`,
      ).toBeUndefined();
    }
    expect(readUiSettings({ menuBarIcons: true }, 1)).toBeUndefined();
    expect(readUiSettings({ trayIcon: false }, 1)).toBeUndefined();
    expect(readUiSettings({ menuBarIcon: true, previews: true }, 1)).toBeUndefined();
    expect(readUiSettings({ widgetPreviews: true, extra: 1 }, 1)).toBeUndefined();
  });

  it('absent = on: an older file without the keys reads as the defaults', () => {
    const older = readUiSettings({ underTheHood: true, menuExpanded: false });
    expect(older).toEqual({ underTheHood: true, menuExpanded: false });
    expect(trayPrefsInForce(older)).toEqual({ menuBarIcon: true, widgetPreviews: true });
    expect(trayPrefsInForce(undefined)).toEqual({ menuBarIcon: true, widgetPreviews: true });
    expect(trayPrefsInForce({})).toEqual({ menuBarIcon: true, widgetPreviews: true });
    expect(trayPrefsInForce({ menuBarIcon: false })).toEqual({
      menuBarIcon: false,
      widgetPreviews: true,
    });
    expect(trayPrefsInForce({ widgetPreviews: false })).toEqual({
      menuBarIcon: true,
      widgetPreviews: false,
    });
  });

  it('a change merges without touching any other key', () => {
    const stored = readUiSettings({ underTheHood: true, notify: { messages: true } }) ?? {};
    expect(mergeUiSettings(stored, { menuBarIcon: false })).toEqual({
      underTheHood: true,
      notify: { messages: true },
      menuBarIcon: false,
    });
    expect(
      mergeUiSettings({ menuBarIcon: false, widgetPreviews: false }, { widgetPreviews: true }),
    ).toEqual({ menuBarIcon: false, widgetPreviews: true });
  });
});
