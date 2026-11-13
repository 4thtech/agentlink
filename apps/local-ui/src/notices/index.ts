// The local app's side of the one notice system (docs/design/notices.md; components in
// @4thtech-io/ui: Toast/ToastStack, Banner, PageNotice):
//
// - `notify()`: any page raises a toast; the shell's one ToastStack (layout/contact-toasts.tsx)
//   shows it. Text only (I-5): never a link, code, key or another party's message text.
// - `useDismissed(key)`: a dismissal remembered in this browser (localStorage), for notices that
//   may be closed before they are resolved. Keys are fixed words plus an ID's name; nothing else.
// - `useArchived(id)`: the removed connections the owner archived on Home, per ID (contact refs),
//   and (RET-5, D-148) the conversations the owner archived from a person's menu
//   (`useConversationsArchived`). Both are kept by the app for every browser (prefs/app-kept.ts).
// Storage can be missing or blocked: every access is wrapped, and the choice then lasts while the
// page is open.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ToastItem } from '@4thtech-io/ui';
import { keepInApp, onKeptLoaded } from '../prefs/app-kept.js';

// --- toasts -----------------------------------------------------------------------------------

export type Toastable = Omit<ToastItem, 'id'>;
type Listener = (toast: ToastItem) => void;
const toastListeners = new Set<Listener>();
let toastSeq = 0;

/** Raises a toast in the shell's stack. Returns its id. */
export function notify(toast: Toastable): number {
  toastSeq += 1;
  const item: ToastItem = { ...toast, id: `n${toastSeq}` };
  for (const l of toastListeners) l(item);
  return toastSeq;
}

export function subscribeToasts(listener: Listener): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

// --- remembered dismissals ----------------------------------------------------------------------

export const DISMISSED_KEY = 'agentlink.notices.dismissed.v1';
const KEY = /^[a-z][a-z0-9-]{0,40}(:[A-Za-z0-9._-]{1,80})?$/;
const MAX_KEYS = 200;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readList(name: string, valid: (v: string) => boolean, max: number): string[] {
  try {
    const raw = storage()?.getItem(name);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && valid(v)).slice(-max);
  } catch {
    return [];
  }
}

function writeList(name: string, list: readonly string[], max: number): void {
  try {
    storage()?.setItem(name, JSON.stringify(list.slice(-max)));
  } catch {
    // Not remembered; the page keeps it while it is open.
  }
  // UX1113-QA-HOST: the app keeps it too (storage is per launch, prefs/app-kept.ts).
  keepInApp(name);
}

const dismissedHere = new Set<string>();
const dismissListeners = new Set<() => void>();
let dismissVersion = 0;

/** A notice key: a fixed word, optionally `:` and an ID's name (e.g. `protect-approvals:tali`). */
export function noticeKey(word: string, id?: string): string {
  return id === undefined || id === '' ? word : `${word}:${id}`;
}

export function isDismissed(key: string): boolean {
  if (!KEY.test(key)) return false;
  return (
    dismissedHere.has(key) || readList(DISMISSED_KEY, (v) => KEY.test(v), MAX_KEYS).includes(key)
  );
}

export function dismissNotice(key: string): void {
  if (!KEY.test(key)) return;
  dismissedHere.add(key);
  const list = readList(DISMISSED_KEY, (v) => KEY.test(v), MAX_KEYS).filter((k) => k !== key);
  writeList(DISMISSED_KEY, [...list, key], MAX_KEYS);
  dismissVersion += 1;
  for (const l of dismissListeners) l();
}

/** Tests: forget the in-memory dismissals (storage is the test's own). */
export function resetNoticesForTests(): void {
  dismissedHere.clear();
  archivedHere.clear();
  conversationsHere.clear();
  dismissVersion += 1;
  archiveVersion += 1;
}

function subscribeDismissed(l: () => void): () => void {
  dismissListeners.add(l);
  return () => {
    dismissListeners.delete(l);
  };
}

/** [dismissed, dismiss] for one notice key; every notice with the same key follows. */
export function useDismissed(key: string): readonly [boolean, () => void] {
  useSyncExternalStore(
    subscribeDismissed,
    () => dismissVersion,
    () => dismissVersion,
  );
  const dismissed = isDismissed(key);
  const dismiss = useCallback(() => dismissNotice(key), [key]);
  return [dismissed, dismiss] as const;
}

// --- archived connections (Home) ----------------------------------------------------------------

export const ARCHIVED_KEY = 'agentlink.home.archived.v1';
const REF = /^0x[0-9a-f]{40}$/;
const ID_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_ARCHIVED = 500;
const archivedHere = new Map<string, Set<string>>();
const archiveListeners = new Set<() => void>();
let archiveVersion = 0;

const entry = (id: string, ref: string): string => `${id}/${ref}`;
function validEntry(v: string): boolean {
  const [id, ref, rest] = v.split('/');
  return (
    rest === undefined && id !== undefined && ref !== undefined && ID_NAME.test(id) && REF.test(ref)
  );
}

/** RET-5 (D-148): conversations archived from a person's menu (`<ID name>/<contact ref>`). */
export const CONVERSATIONS_ARCHIVED_KEY = 'agentlink.conversations.archived.v1';
const conversationsHere = new Map<string, Set<string>>();

function listedFor(id: string, key: string, here: Map<string, Set<string>>): Set<string> {
  const out = new Set(here.get(id) ?? []);
  for (const v of readList(key, validEntry, MAX_ARCHIVED)) {
    const [owner, ref] = v.split('/');
    if (owner === id && ref !== undefined) out.add(ref);
  }
  return out;
}

/** The contact refs archived for this ID: removed connections and archived conversations. */
export function archivedOf(id: string): ReadonlySet<string> {
  if (!ID_NAME.test(id)) return new Set();
  return new Set([
    ...listedFor(id, ARCHIVED_KEY, archivedHere),
    ...listedFor(id, CONVERSATIONS_ARCHIVED_KEY, conversationsHere),
  ]);
}

/** RET-5: the conversations the owner archived for this ID (any connection, removed or not). */
export function conversationsArchivedOf(id: string): ReadonlySet<string> {
  if (!ID_NAME.test(id)) return new Set();
  return listedFor(id, CONVERSATIONS_ARCHIVED_KEY, conversationsHere);
}

/** RET-5: Archive or Unarchive a conversation (no presence, nothing deleted; the AI still sees it). */
export function setConversationArchived(id: string, ref: string, archived: boolean): void {
  const lower = ref.toLowerCase();
  if (!ID_NAME.test(id) || !REF.test(lower)) return;
  const here = conversationsHere.get(id) ?? new Set<string>();
  if (archived) here.add(lower);
  else here.delete(lower);
  conversationsHere.set(id, here);
  const list = readList(CONVERSATIONS_ARCHIVED_KEY, validEntry, MAX_ARCHIVED).filter(
    (v) => v !== entry(id, lower),
  );
  writeList(
    CONVERSATIONS_ARCHIVED_KEY,
    archived ? [...list, entry(id, lower)] : list,
    MAX_ARCHIVED,
  );
  archiveVersion += 1;
  for (const l of archiveListeners) l();
}

export function setArchived(id: string, ref: string, archived: boolean): void {
  const lower = ref.toLowerCase();
  if (!ID_NAME.test(id) || !REF.test(lower)) return;
  const here = archivedHere.get(id) ?? new Set<string>();
  if (archived) here.add(lower);
  else here.delete(lower);
  archivedHere.set(id, here);
  const list = readList(ARCHIVED_KEY, validEntry, MAX_ARCHIVED).filter(
    (v) => v !== entry(id, lower),
  );
  writeList(ARCHIVED_KEY, archived ? [...list, entry(id, lower)] : list, MAX_ARCHIVED);
  archiveVersion += 1;
  for (const l of archiveListeners) l();
}

// UX1113-QA-HOST: the app's copy of dismissals and Archive arrived at start: read storage again.
onKeptLoaded(() => {
  dismissVersion += 1;
  archiveVersion += 1;
  for (const l of dismissListeners) l();
  for (const l of archiveListeners) l();
});

function subscribeArchived(l: () => void): () => void {
  archiveListeners.add(l);
  return () => {
    archiveListeners.delete(l);
  };
}

/** RET-5: the archived conversations of the open ID, following every Archive and Unarchive. */
export function useConversationsArchived(id: string | undefined): ReadonlySet<string> {
  const version = useSyncExternalStore(
    subscribeArchived,
    () => archiveVersion,
    () => archiveVersion,
  );
  return useMemo(
    () => (id === undefined ? new Set<string>() : conversationsArchivedOf(id)),
    // `version` changes on every archive or restore.
    [id, version],
  );
}

/** The archived refs of the open ID, following every archive and restore. */
export function useArchived(id: string | undefined): ReadonlySet<string> {
  const version = useSyncExternalStore(
    subscribeArchived,
    () => archiveVersion,
    () => archiveVersion,
  );
  return useMemo(
    () => (id === undefined ? new Set<string>() : archivedOf(id)),
    // `version` changes on every archive or restore.
    [id, version],
  );
}
