// The sidebar, seven items (D-120): Approvals, Activity, Contacts, Files, Proofs & credits, Rules and
// Settings (Backup, Passkeys, Advanced in a sub-navigation). Before: the settings pages (d1/screens/local). Approvals still lives on the
// approval page at `/` until M1-11b-2 moves it here, so that link is not routed by this app.
import { PAGE_TITLES } from './strings.js';

export const SETTINGS_LABEL = 'Settings';
export const PASSKEYS_LABEL = 'Passkeys';

export interface AppNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly path: string;
  /** True when this app routes the path; false hands the click to the browser. */
  readonly routed: boolean;
}

export const NAV_ITEMS: readonly AppNavItem[] = [
  { id: 'approvals', label: PAGE_TITLES.approvals, icon: 'approval', path: '/', routed: false },
  {
    id: 'activity',
    label: PAGE_TITLES.activity,
    icon: 'activity',
    path: '/settings/activity',
    routed: true,
  },
  {
    id: 'contacts',
    label: PAGE_TITLES.contacts,
    icon: 'users',
    path: '/settings/contacts',
    routed: true,
  },
  { id: 'files', label: PAGE_TITLES.files, icon: 'folder', path: '/settings/files', routed: true },
  {
    id: 'proofs',
    label: PAGE_TITLES.proofs,
    icon: 'proof-seal',
    path: '/settings/proofs',
    routed: true,
  },
  {
    id: 'rules',
    label: PAGE_TITLES.rules,
    icon: 'sliders-horizontal',
    path: '/settings/rules',
    routed: true,
  },
  {
    id: 'settings',
    label: SETTINGS_LABEL,
    icon: 'settings',
    path: '/settings/backup',
    routed: true,
  },
];

/** The pages under the one Settings item, in the order of its sub-navigation (11 §6.2.1). */
export const SETTINGS_PAGES: readonly { readonly label: string; readonly path: string }[] = [
  { label: PAGE_TITLES.backup, path: '/settings/backup' },
  { label: PASSKEYS_LABEL, path: '/settings/passkeys' },
  { label: PAGE_TITLES.advanced, path: '/settings/advanced' },
];

/** Old paths that still work and where they now go. Storage lives inside Files. */
export const REDIRECTS: Readonly<Record<string, string>> = {
  '/settings/storage': '/settings/files',
};
