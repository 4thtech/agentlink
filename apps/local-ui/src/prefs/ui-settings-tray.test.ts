// @vitest-environment jsdom
// TRAY-TOGGLE (D-155): the page saves the two menu bar widget switches through the one strict
// ui-settings path, and nothing else rides along.
import { afterEach, describe, expect, it } from 'vitest';
import {
  readStoredUiSettings,
  resetUiSettingsForTests,
  saveUiSettings,
  startUiSettings,
} from './ui-settings.js';

afterEach(() => resetUiSettingsForTests());

function seam(answer: unknown): {
  calls: { method: string; body: unknown }[];
  fetch: typeof fetch;
} {
  const calls: { method: string; body: unknown }[] = [];
  const fetchImpl = ((_: unknown, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

describe('ui-settings: menu bar widget switches', () => {
  it('saves menuBarIcon and widgetPreviews as the exact booleans', async () => {
    const s = seam({});
    await startUiSettings({ fetch: s.fetch });
    s.calls.length = 0;
    expect(await saveUiSettings({ menuBarIcon: false })).toBe(true);
    expect(await saveUiSettings({ widgetPreviews: false })).toBe(true);
    expect(s.calls).toEqual([
      { method: 'PUT', body: { menuBarIcon: false } },
      { method: 'PUT', body: { widgetPreviews: false } },
    ]);
  });

  it('never sends a wrong type or an unknown key', async () => {
    const s = seam({});
    await startUiSettings({ fetch: s.fetch });
    s.calls.length = 0;
    const loose = saveUiSettings as (change: unknown) => Promise<boolean>;
    expect(await loose({ menuBarIcon: 'false' })).toBe(false);
    expect(await loose({ widgetPreviews: 1 })).toBe(false);
    expect(await loose({ menuBarIcons: true })).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it('reads the stored switches back', async () => {
    const s = seam({ menuBarIcon: false, widgetPreviews: true });
    await startUiSettings({ fetch: s.fetch });
    expect(await readStoredUiSettings()).toEqual({ menuBarIcon: false, widgetPreviews: true });
  });
});
