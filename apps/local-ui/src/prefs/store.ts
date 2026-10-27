// UI-REFRESH-e (S1): the one preference store (B-11 §7, §14). Four per-browser settings kept in
// localStorage (reads and writes in try/catch: private windows, blocked or full storage still work for
// the session). The three display settings also land on <html> as data attributes; "system" means no
// attribute, so the system's own light/dark, reduced-motion and reduced-transparency settings decide.
// Nothing here is secret: values come from fixed lists, anything else in storage is ignored.
export type MotionPref = 'system' | 'on' | 'off';
export type TransparencyPref = 'system' | 'reduce';
export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  /** Under the hood: the global switch and its default (off). */
  hood: boolean;
  motion: MotionPref;
  transparency: TransparencyPref;
  theme: ThemePref;
}

export const PREFS_KEY = 'agentlink.prefs';
export const DEFAULT_PREFS: Prefs = {
  hood: false,
  motion: 'system',
  transparency: 'system',
  theme: 'system',
};

const CHOICES = {
  motion: ['system', 'on', 'off'],
  transparency: ['system', 'reduce'],
  theme: ['system', 'light', 'dark'],
} as const;

function parse(raw: string | null): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  if (raw === null) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof data !== 'object' || data === null) return out;
  const d = data as Record<string, unknown>;
  if (typeof d['hood'] === 'boolean') out.hood = d['hood'];
  if (CHOICES.motion.includes(d['motion'] as MotionPref)) out.motion = d['motion'] as MotionPref;
  if (CHOICES.transparency.includes(d['transparency'] as TransparencyPref)) {
    out.transparency = d['transparency'] as TransparencyPref;
  }
  if (CHOICES.theme.includes(d['theme'] as ThemePref)) out.theme = d['theme'] as ThemePref;
  return out;
}

function read(): Prefs {
  try {
    return parse(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function write(p: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage is blocked or full: the choice still holds for this session.
  }
}

function setAttr(name: string, value: string | null): void {
  const el = document.documentElement;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/** Puts the display settings on <html>. `data-motion="full"` records an explicit "off". */
export function applyPrefs(p: Prefs): void {
  setAttr('data-motion', p.motion === 'on' ? 'reduced' : p.motion === 'off' ? 'full' : null);
  setAttr('data-transparency', p.transparency === 'reduce' ? 'reduced' : null);
  setAttr('data-theme', p.theme === 'system' ? null : p.theme);
}

let current: Prefs | null = null;
const listeners = new Set<() => void>();

/** The current settings; the first call loads them and applies the root attributes. */
export function getPrefs(): Prefs {
  if (current === null) {
    current = read();
    applyPrefs(current);
  }
  return current;
}

/** Loads and applies the stored settings. Call once at start-up (before the first paint). */
export function initPrefs(): Prefs {
  return getPrefs();
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next: Prefs = { ...getPrefs(), [key]: value };
  current = next;
  write(next);
  applyPrefs(next);
  for (const l of listeners) l();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the in-memory copy and load again from storage. */
export function resetPrefsForTests(): void {
  current = null;
  getPrefs();
  for (const l of listeners) l();
}
