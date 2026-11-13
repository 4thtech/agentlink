// W4-SHELL-V2 (Decision 49–51; 08 §1, proposed): the local app's UI settings, kept by the app (not
// per browser): `GET /api/ui/ui-settings` and `PUT /api/ui/ui-settings`. Two allowlisted switches,
// "Under the hood" and whether the section menu is expanded, and (UX1113-QA-HOST) `kept`: the page
// choices the browser used to keep alone. The app listens on a new port on every launch, so the
// browser's storage for the page starts empty each time; `kept` carries a fixed set of those
// storage keys, each with its own strict value shape: fixed words, flags, a time, step IDs, notice
// keys, and the owner's own ID names with contact refs (Archive, Keep both). No path, secret, code,
// display name or other free text ever travels here. Both sides check against this one definition
// (and the samples below), so neither can drift alone: packages/node (api/ui-settings.ts, the gate in
// approval-server.ts), apps/cli (agent-dir.ts, the file) and apps/local-ui (prefs/ui-settings.ts,
// prefs/app-kept.ts).

import { readNotifyPrefs, type NotifyPrefs } from './notifications.js';

export const UI_SETTINGS_PATH = '/api/ui/ui-settings';

/** The only keys the route reads, writes or stores. */
// N6: `notify`, the switches of Settings › Notifications (booleans of fixed keys, notifications.ts).
export const UI_SETTINGS_KEYS = ['underTheHood', 'menuExpanded', 'kept', 'notify'] as const;
export type UiSettingKey = (typeof UI_SETTINGS_KEYS)[number];

// --- kept page choices ---------------------------------------------------------------------------

const REF = /^0x[0-9a-f]{40}$/;
const ID_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const NOTICE_KEY = /^[a-z][a-z0-9-]{0,40}(:[A-Za-z0-9._-]{1,80})?$/;
const STEP_IDS: readonly string[] = [
  'protect',
  'name',
  'connect',
  'invite',
  'check',
  'send',
  'reply',
  'kit',
];
/** At most this many entries in one kept list (the page keeps the newest). */
export const UI_KEPT_MAX_ENTRIES = 200;
/** The display choices (apps/local-ui prefs/store.ts), each from its fixed list. */
const PREF_CHOICES: Readonly<Record<string, readonly (string | boolean)[]>> = {
  hood: [true, false],
  motion: ['system', 'on', 'off'],
  transparency: ['system', 'reduce'],
  theme: ['system', 'light', 'dark'],
  approvalsLayout: ['grid', 'list'],
  activitySort: ['recent', 'active'],
};

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON list of strings that each pass `valid`, at most `max` (the newest kept). */
function list(valid: (v: string) => boolean, max = UI_KEPT_MAX_ENTRIES) {
  return (raw: string): string | undefined => {
    const data = parsed(raw);
    if (!Array.isArray(data)) return undefined;
    if (!data.every((v): v is string => typeof v === 'string' && valid(v))) return undefined;
    return data.length > max ? undefined : raw;
  };
}

const fixed =
  (...words: string[]) =>
  (raw: string): string | undefined =>
    words.includes(raw) ? raw : undefined;

function prefs(raw: string): string | undefined {
  if (raw.length > 256) return undefined;
  const data = parsed(raw);
  if (!plainObject(data)) return undefined;
  for (const [key, v] of Object.entries(data)) {
    const choices = Object.prototype.hasOwnProperty.call(PREF_CHOICES, key)
      ? PREF_CHOICES[key]
      : undefined;
    if (choices === undefined || !choices.includes(v as string | boolean)) return undefined;
  }
  return raw;
}

/**
 * The page's storage keys the app keeps, each with the one check of its value (the exact string the
 * page stores; undefined refuses it). Names are the page's own (notices/index.ts, prefs/store.ts,
 * states/recovery-kit.ts, pages/…).
 */
const KEPT: Readonly<Record<string, (raw: string) => string | undefined>> = Object.freeze({
  /** Appearance (theme, motion, transparency), Under the hood, Approvals layout, sort. */
  'agentlink.prefs': prefs,
  /** Notices closed before they were resolved (fixed words plus an ID's name). */
  'agentlink.notices.dismissed.v1': list((v) => NOTICE_KEY.test(v)),
  /** Home › Archive: `<ID name>/<contact ref>`. */
  'agentlink.home.archived.v1': list((v) => {
    const [id, ref, rest] = v.split('/');
    return rest === undefined && ID_NAME.test(id ?? '') && REF.test(ref ?? '');
  }),
  /** The recovery kit was put off ("Later"): a time in ms only. */
  'agentlink.recoveryKit.later': (raw) => (/^[0-9]{1,16}$/.test(raw) ? raw : undefined),
  'agentlink.getStarted.hidden': fixed('1'),
  /** Get started was left (Skip to Home or Done): it does not open by itself again. */
  'agentlink.getStarted.left': fixed('1'),
  'agentlink.idsFit.hidden': fixed('1'),
  'agentlink.idExplainer.hidden': fixed('1'),
  'agentlink:tidy-dismissed': fixed('1'),
  'agentlink:agents-opened': fixed('1'),
  /** Start here steps seen done once (step IDs only). */
  'agentlink.startHere.done': list((v) => STEP_IDS.includes(v), STEP_IDS.length),
  /** People › Keep both: `<newer ref>:<older ref>`. */
  'agentlink.contacts.duplicates-kept.v1': list((v) => {
    const [a, b, rest] = v.split(':');
    return rest === undefined && REF.test(a ?? '') && REF.test(b ?? '');
  }),
  'agentlink.files.untrusted-note': fixed('seen'),
  'agentlink:map-show-quiet': fixed('0', '1'),
});

/** The page storage keys the app keeps (UX1113-QA-HOST). */
export const UI_KEPT_KEYS: readonly string[] = Object.freeze(Object.keys(KEPT));

/** Kept choices: a key's stored string, or null in a PUT to forget it (never stored). */
export type UiKept = { readonly [key: string]: string | null };

/** The stored settings: a key is absent until it was first set (the page then uses its default). */
export interface UiSettings {
  readonly underTheHood?: boolean;
  readonly menuExpanded?: boolean;
  readonly kept?: UiKept;
  /** N6: Settings › Notifications; a key is absent until set (the D2 default applies). */
  readonly notify?: NotifyPrefs;
}

/** The longest kept value (the largest list of the largest entries fits). */
const MAX_KEPT_VALUE_CHARS = 28 * 1024;

/** The checked value of one kept key, or undefined (an unknown key or a value of the wrong shape). */
export function readKeptValue(key: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_KEPT_VALUE_CHARS) return undefined;
  const check = Object.prototype.hasOwnProperty.call(KEPT, key) ? KEPT[key] : undefined;
  return check === undefined ? undefined : check(raw);
}

function readKept(value: unknown): UiKept | undefined {
  if (!plainObject(value)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null && Object.prototype.hasOwnProperty.call(KEPT, key)) {
      out[key] = null;
      continue;
    }
    const checked = readKeptValue(key, raw);
    if (checked === undefined) return undefined;
    out[key] = checked;
  }
  return Object.freeze(out);
}

/** The longest PUT body the gate reads (every kept key at its largest fits). */
export const UI_SETTINGS_MAX_BODY_BYTES = 96 * 1024;

/**
 * The one strict reading of a settings object (a PUT body or the stored file): a plain object whose
 * keys are allowlisted, the switches booleans and `kept` a plain object of allowlisted keys, each a
 * value of its own shape (or null: forget). `minKeys` 1 for a PUT (an empty change is refused).
 * Anything else is undefined; the caller never echoes it.
 */
export function readUiSettings(value: unknown, minKeys = 0): UiSettings | undefined {
  if (!plainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length < minKeys || keys.length > UI_SETTINGS_KEYS.length) return undefined;
  const out: {
    underTheHood?: boolean;
    menuExpanded?: boolean;
    kept?: UiKept;
    notify?: NotifyPrefs;
  } = {};
  for (const key of keys) {
    const v = value[key];
    if (key === 'underTheHood' || key === 'menuExpanded') {
      if (typeof v !== 'boolean') return undefined;
      out[key] = v;
    } else if (key === 'kept') {
      const kept = readKept(v);
      if (kept === undefined) return undefined;
      out.kept = kept;
    } else if (key === 'notify') {
      const notify = readNotifyPrefs(v);
      if (notify === undefined) return undefined;
      out.notify = notify;
    } else {
      return undefined;
    }
  }
  return Object.freeze(out);
}

/** Merges a change into stored settings: `kept` key by key, a null forgets that key. */
export function mergeUiSettings(stored: UiSettings, change: UiSettings): UiSettings {
  const next: {
    underTheHood?: boolean;
    menuExpanded?: boolean;
    kept?: UiKept;
    notify?: NotifyPrefs;
  } = {
    ...stored,
    ...change,
  };
  if (change.notify !== undefined) {
    next.notify = Object.freeze({ ...stored.notify, ...change.notify });
  }
  if (change.kept !== undefined) {
    const kept: Record<string, string | null> = { ...stored.kept, ...change.kept };
    for (const key of Object.keys(kept)) if (kept[key] === null) delete kept[key];
    next.kept = Object.freeze(kept);
  }
  return Object.freeze(next);
}

/** Typed samples of the wire, for both sides' contract tests. */
export const UI_SETTINGS_SAMPLES = {
  /** Never set: the page uses its defaults (Under the hood off, menu minimized). */
  empty: { status: 200, body: {} },
  stored: { status: 200, body: { underTheHood: true, menuExpanded: false } },
  /** A PUT that turns Under the hood on; the answer is the whole stored object. */
  put: { body: { underTheHood: true }, answer: { status: 200, body: { underTheHood: true } } },
  /** Refused PUT bodies (400 `invalid`, never echoed). */
  invalid: [
    {},
    { underTheHood: 'yes' },
    { underTheHood: true, theme: 'dark' },
    { path: '/etc/passwd' },
    [true],
    null,
  ],
  /** Outside the app host a PUT is not available (501). */
  notAvailable: { status: 501, body: { error: 'not_available' } },
} as const;
