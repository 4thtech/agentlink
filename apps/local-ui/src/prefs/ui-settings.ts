// W4-SHELL-V2 (Decisions 49–51; 08 §1, proposed): "Under the hood" and the section menu are kept by
// the local app (`GET/PUT /api/ui/ui-settings`), not per browser, so every window agrees. The
// preference store (store.ts) stays the one in-memory source the pages read (`prefs.hood`); this
// module keeps it in step with the app:
//
// - on start, the app's stored value wins; when the app has none yet, a `hood` this browser kept in
//   localStorage is sent once (the one-time import), so nobody loses the switch on update;
// - any change of `prefs.hood` (the top bar switch, ⌘⇧U, Cmd+K, Settings › Appearance) is saved;
// - the menu's expanded state is saved the same way.
// Failures never block the page: the switch keeps working for this window (offline, not the app
// host). Only the two allowlisted booleans are ever sent; nothing is logged.
import {
  UI_SETTINGS_PATH,
  readUiSettings,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';
import { getPrefs, setPref, subscribePrefs } from './store.js';

export type UiSettingsFetch = typeof fetch;

let menuExpanded = false;
const menuListeners = new Set<() => void>();
let started = false;
let fetchImpl: UiSettingsFetch | undefined;
/** The hood value the app is known to hold (undefined: none yet or unknown). */
let synced: boolean | undefined;
let unsubscribe: (() => void) | undefined;
/** W4-SHELL-LIVE: the first read is done (or given up on), so Under the hood and the menu hold. */
let settled = false;
const settledListeners = new Set<() => void>();

/** Marks the first read done (also after the shell's short wait); the shell then shows the body. */
export function settleUiSettings(): void {
  if (settled) return;
  settled = true;
  for (const l of settledListeners) l();
}

export function uiSettingsSettled(): boolean {
  return settled;
}

export function subscribeUiSettingsSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

function token(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const doFetch = (): UiSettingsFetch =>
  fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

async function read(): Promise<UiSettings | undefined> {
  try {
    const res = await doFetch()(UI_SETTINGS_PATH, {
      method: 'GET',
      headers: { 'X-AgentLink-CSRF': token() },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    return readUiSettings(await res.json());
  } catch {
    return undefined;
  }
}

/** Saves a change; resolves true when the app stored it. Never throws. */
export async function saveUiSettings(change: UiSettings): Promise<boolean> {
  const checked = readUiSettings({ ...change }, 1);
  if (checked === undefined) return false;
  try {
    const res = await doFetch()(UI_SETTINGS_PATH, {
      method: 'PUT',
      headers: {
        'X-AgentLink-CSRF': token(),
        'Content-Type': 'application/octet-stream',
      },
      body: JSON.stringify(checked),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function onPrefs(): void {
  const hood = getPrefs().hood;
  if (hood === synced) return;
  synced = hood;
  void saveUiSettings({ underTheHood: hood });
}

/**
 * Loads the app's settings once per page (the shell calls it on mount) and starts saving changes.
 * Resolves when the first read is done.
 */
export async function startUiSettings(seam?: { fetch?: UiSettingsFetch }): Promise<void> {
  if (started) return;
  started = true;
  if (seam?.fetch !== undefined) fetchImpl = seam.fetch;
  synced = getPrefs().hood;
  unsubscribe = subscribePrefs(onPrefs);
  const stored = await read();
  if (stored?.underTheHood !== undefined) {
    synced = stored.underTheHood;
    if (getPrefs().hood !== stored.underTheHood) setPref('hood', stored.underTheHood);
  } else if (stored !== undefined && getPrefs().hood) {
    // The one-time import: this browser's earlier choice becomes the app's.
    synced = true;
    void saveUiSettings({ underTheHood: true });
  }
  if (stored?.menuExpanded !== undefined && stored.menuExpanded !== menuExpanded) {
    menuExpanded = stored.menuExpanded;
    for (const l of menuListeners) l();
  }
  settleUiSettings();
}

/** Turns Under the hood on or off (saved by the app). */
export function setUnderTheHood(on: boolean): void {
  setPref('hood', on);
}

export function getMenuExpanded(): boolean {
  return menuExpanded;
}

export function setMenuExpanded(on: boolean): void {
  if (on === menuExpanded) return;
  menuExpanded = on;
  for (const l of menuListeners) l();
  void saveUiSettings({ menuExpanded: on });
}

export function subscribeMenuExpanded(listener: () => void): () => void {
  menuListeners.add(listener);
  return () => menuListeners.delete(listener);
}

/** Test seam: forget everything (the next start reads again). */
export function resetUiSettingsForTests(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  started = false;
  fetchImpl = undefined;
  synced = undefined;
  menuExpanded = false;
  settled = false;
  for (const l of menuListeners) l();
  for (const l of settledListeners) l();
}
