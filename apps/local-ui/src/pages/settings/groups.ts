// The Settings groups (design-1112 §3.1). The pages themselves come from `SETTINGS_PAGES` (nav.ts),
// so a page added there appears on Settings home and in the side list without a change here: a path
// this file does not know goes to "This app" under its own label. Order inside a group follows
// `ORDER`; unknown paths come last, in the order nav.ts lists them.
import type { SettingsPage } from '../../nav.js';

export type GroupId = 'safety' | 'ai' | 'app';
export const GROUP_ORDER: readonly GroupId[] = ['safety', 'ai', 'app'];

const GROUP_OF: Readonly<Record<string, GroupId>> = {
  '/settings/backup': 'safety',
  '/settings/touch-id': 'safety',
  '/settings/rules': 'ai',
  '/settings/apps': 'ai',
  '/settings/files': 'ai',
  '/settings/storage': 'app',
  '/settings/appearance': 'app',
  '/settings/proofs': 'app',
  '/settings/updates': 'app',
  '/settings/advanced': 'app',
  '/advanced/network': 'app',
};

const ORDER: readonly string[] = [
  '/settings/backup',
  '/settings/touch-id',
  '/settings/rules',
  '/settings/apps',
  '/settings/files',
  '/settings/storage',
  '/settings/appearance',
  '/settings/proofs',
  '/settings/updates',
  '/settings/advanced',
  '/advanced/network',
];

export function groupOf(path: string): GroupId {
  return GROUP_OF[path] ?? 'app';
}

export interface SettingsGroup {
  readonly id: GroupId;
  readonly pages: readonly SettingsPage[];
}

/** Every page exactly once, in groups (empty groups left out). */
export function settingsGroups(pages: readonly SettingsPage[]): readonly SettingsGroup[] {
  const rank = (p: SettingsPage): number => {
    const i = ORDER.indexOf(p.path);
    return i === -1 ? ORDER.length : i;
  };
  return GROUP_ORDER.map((id) => ({
    id,
    pages: pages
      .filter((p) => groupOf(p.path) === id)
      .map((p, i) => ({ p, i }))
      .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
      .map((x) => x.p),
  })).filter((g) => g.pages.length > 0);
}
