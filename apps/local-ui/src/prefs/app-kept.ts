// UX1113-QA-HOST (B3): the app listens on a new port on every launch, so this browser's storage for
// the page (one origin per port) starts empty each time and every choice kept there was lost. The
// app now keeps those choices for the owner: UI settings `kept` (GET/PUT /api/ui/ui-settings, the
// same session, CSRF and Origin gates; the allowlist and each value's shape are the contract's,
// @4thtech-io/types ui-contract/ui-settings.ts). Storage stays the pages' working copy and the
// fallback while the app can't be reached:
//
// - at start (prefs/ui-settings.ts), the app's copy fills storage (it wins; a key it doesn't hold is
//   cleared), unless the page changed that key before the read landed;
// - when the app holds none yet, this browser's values are sent once (the one-time move);
// - every later change is sent (`keepInApp(key)` after a page writes its key; a removed key is sent
//   as null, so the app forgets it). Changes in one tick go in one request.
// Only allowlisted keys with a value of the right shape are ever sent; nothing is logged.
import {
  UI_KEPT_KEYS,
  UI_KEPT_MAX_ENTRIES,
  readKeptValue,
  type UiSettings,
} from '@4thtech-io/types/ui-contract/ui-settings';

type Sender = (change: UiSettings) => Promise<boolean>;

let sender: Sender | undefined;
const pending = new Set<string>();
let flushQueued = false;
const loadedListeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** A list longer than the app keeps is cut to its newest entries (the page keeps the newest too). */
function trimmed(raw: string): string {
  try {
    const data: unknown = JSON.parse(raw);
    if (Array.isArray(data) && data.length > UI_KEPT_MAX_ENTRIES) {
      return JSON.stringify(data.slice(-UI_KEPT_MAX_ENTRIES));
    }
  } catch {
    // Not a list: checked as it is.
  }
  return raw;
}

/** What to send for a key: its checked value, null when it is gone, undefined to skip it. */
function valueOf(key: string): string | null | undefined {
  let raw: string | null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return undefined;
  }
  return raw === null ? null : readKeptValue(key, trimmed(raw));
}

function flush(): void {
  flushQueued = false;
  if (sender === undefined || pending.size === 0) return;
  const kept: Record<string, string | null> = {};
  for (const key of pending) {
    const value = valueOf(key);
    if (value !== undefined) kept[key] = value;
  }
  pending.clear();
  if (Object.keys(kept).length > 0) void sender({ kept });
}

function schedule(): void {
  if (flushQueued || sender === undefined) return;
  flushQueued = true;
  setTimeout(flush, 0);
}

/** A page wrote (or removed) one of the kept keys in storage: the app keeps it too. */
export function keepInApp(key: string): void {
  if (!UI_KEPT_KEYS.includes(key)) return;
  pending.add(key);
  schedule();
}

/**
 * At start, with the app's settings (undefined: the app was out of reach, so storage alone holds
 * the choices for this page). Returns true when the app's copy was put in storage.
 */
export function startKept(stored: UiSettings | undefined, send: Sender): boolean {
  if (stored === undefined) return false;
  const s = storage();
  const applied = stored.kept !== undefined;
  if (stored.kept !== undefined) {
    for (const key of UI_KEPT_KEYS) {
      if (pending.has(key)) continue;
      const value = readKeptValue(key, stored.kept[key]);
      try {
        if (value === undefined) s?.removeItem(key);
        else s?.setItem(key, value);
      } catch {
        // Storage refused: the page shows its defaults; the app still holds the choice.
      }
    }
  } else {
    // The one-time move: what this browser kept before becomes the app's.
    for (const key of UI_KEPT_KEYS) if (valueOf(key) !== null) pending.add(key);
  }
  sender = send;
  if (applied) for (const l of loadedListeners) l();
  schedule();
  return applied;
}

/** Runs after the app's copy was put in storage (pages that hold a copy in memory read again). */
export function onKeptLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
}

/** Test seam: forget the sender and anything waiting (the next start begins again). */
export function resetKeptForTests(): void {
  sender = undefined;
  pending.clear();
  flushQueued = false;
}
