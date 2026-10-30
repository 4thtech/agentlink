// W4-SHELL-V2 (Decision 49–51; 08 §1, proposed): the local app's UI settings, kept by the app (not
// per browser): `GET /api/ui/ui-settings` and `PUT /api/ui/ui-settings`. Two allowlisted switches,
// nothing else: "Under the hood" and whether the section menu is expanded. No path, key, name or
// free text ever travels here. Both sides check against this one definition (and the samples below),
// so neither can drift alone: packages/node (api/ui-settings.ts, the gate in approval-server.ts) and
// apps/local-ui (prefs/ui-settings.ts).

export const UI_SETTINGS_PATH = '/api/ui/ui-settings';

/** The only keys the route reads, writes or stores. */
export const UI_SETTINGS_KEYS = ['underTheHood', 'menuExpanded'] as const;
export type UiSettingKey = (typeof UI_SETTINGS_KEYS)[number];

/** The stored settings: a key is absent until it was first set (the page then uses its default). */
export type UiSettings = { readonly [K in UiSettingKey]?: boolean };

/** The longest PUT body the gate reads (`{"underTheHood":false,"menuExpanded":false}` is 43). */
export const UI_SETTINGS_MAX_BODY_BYTES = 128;

/**
 * The one strict reading of a settings object (a PUT body or the stored file): a plain object whose
 * keys are allowlisted and whose values are booleans. `minKeys` 1 for a PUT (an empty change is
 * refused). Anything else is undefined; the caller never echoes it.
 */
export function readUiSettings(value: unknown, minKeys = 0): UiSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Object.keys(value);
  if (keys.length < minKeys || keys.length > UI_SETTINGS_KEYS.length) return undefined;
  const out: { [K in UiSettingKey]?: boolean } = {};
  for (const key of keys) {
    if (!(UI_SETTINGS_KEYS as readonly string[]).includes(key)) return undefined;
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== 'boolean') return undefined;
    out[key as UiSettingKey] = v;
  }
  return Object.freeze(out);
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
