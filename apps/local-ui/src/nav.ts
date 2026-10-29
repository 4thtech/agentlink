// W4-SHELL (Decision 40; b11 §34.1, §34.6; WAVE-4 build plan §3): the wave-4 information
// architecture. Two destinations only, Inbox (the home) and Contacts. Everything else is under
// Settings, reached from the avatar menu at the right of the top bar and from Cmd+K: Settings (AI
// apps, Backup & Touch ID, Appearance, Proofs & credits, Default rules, Notifications) and its
// Advanced group (the full activity log, files and storage, network and relays, diagnostics). The
// agent switcher (top left) holds the agents and the AI apps. Every route here points at today's
// page; the Inbox, Contacts and Settings builders replace those page bodies in their own folders.
import { AGENTS_PATH } from './pages/agents/data.js';
import { PAGE_TITLES } from './strings.js';

export const SETTINGS_LABEL = 'Settings';
export const ADVANCED_LABEL = 'Advanced';

export const INBOX_PATH = '/inbox';
export const CONTACTS_PATH = '/contacts';
/**
 * Approvals fold into the Inbox (b11 §34.4). Until the Inbox holds them, the waiting list stays at
 * `/`, where every approval link of the terminal, the MCP and notifications already points; it marks
 * the Inbox item current.
 */
export const APPROVALS_PATH = '/';
export const SETTINGS_HOME = '/settings/apps';
export const ADVANCED_HOME = '/settings/activity';

export interface AppNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly path: string;
  /** True when this app routes the path; false hands the click to the browser. */
  readonly routed: boolean;
}

export const NAV_ITEMS: readonly AppNavItem[] = [
  { id: 'inbox', label: PAGE_TITLES.inbox, icon: 'inbox', path: INBOX_PATH, routed: true },
  { id: 'contacts', label: PAGE_TITLES.contacts, icon: 'users', path: CONTACTS_PATH, routed: true },
];

export interface SettingsPage {
  readonly label: string;
  readonly path: string;
}
export interface SettingsGroup {
  readonly label: string;
  readonly pages: readonly SettingsPage[];
}

/** The Settings sub-navigation, in its two groups (b11 §34.6). */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: SETTINGS_LABEL,
    pages: [
      { label: PAGE_TITLES.apps, path: '/settings/apps' },
      { label: PAGE_TITLES.backupTouchId, path: '/settings/backup' },
      { label: PAGE_TITLES.appearance, path: '/settings/appearance' },
      { label: PAGE_TITLES.proofs, path: '/settings/proofs' },
      { label: PAGE_TITLES.defaultRules, path: '/settings/rules' },
      { label: PAGE_TITLES.notifications, path: '/settings/notifications' },
    ],
  },
  {
    label: ADVANCED_LABEL,
    pages: [
      { label: PAGE_TITLES.activityLog, path: '/settings/activity' },
      { label: PAGE_TITLES.filesStorage, path: '/settings/files' },
      { label: PAGE_TITLES.network, path: '/settings/advanced' },
      { label: PAGE_TITLES.diagnostics, path: '/settings/about' },
    ],
  },
];

/** Every Settings page, in order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = SETTINGS_GROUPS.flatMap((g) => g.pages);

/**
 * Pages that are no destination of their own but still open (deep links, Cmd+K, older links): the
 * title the top bar shows for them, and the nav item marked current (none: no mark).
 */
export const OTHER_PAGES: Readonly<
  Record<string, { readonly title: string; readonly nav?: string }>
> = {
  [APPROVALS_PATH]: { title: PAGE_TITLES.approvals, nav: INBOX_PATH },
  '/settings/home': { title: PAGE_TITLES.home },
  [AGENTS_PATH]: { title: PAGE_TITLES.agents },
  '/first-run': { title: PAGE_TITLES.firstRun },
};

/** Old paths that still work and where they now go. */
export const REDIRECTS: Readonly<Record<string, string>> = {
  '/settings': SETTINGS_HOME,
  '/settings/messages': INBOX_PATH,
  '/settings/contacts': CONTACTS_PATH,
  '/settings/storage': '/settings/files',
  '/settings/passkeys': '/settings/backup',
};

/** One entry of Cmd+K (b11 §34.8): a name and where it goes. */
export interface GoToEntry {
  readonly label: string;
  readonly path: string;
  /** Extra words it is found by. */
  readonly keywords?: string;
}

/** Everything Cmd+K reaches by name, in the order it lists them. */
export const GO_TO: readonly GoToEntry[] = [
  ...NAV_ITEMS.map((i) => ({ label: i.label, path: i.path })),
  { label: PAGE_TITLES.approvals, path: APPROVALS_PATH, keywords: 'needs you waiting' },
  ...SETTINGS_PAGES.map((p) => ({ label: p.label, path: p.path })),
  { label: 'Manage agents & apps', path: AGENTS_PATH, keywords: 'agents rename remove' },
  { label: 'New agent', path: `${AGENTS_PATH}?add=1`, keywords: 'add agent create' },
  { label: PAGE_TITLES.home, path: '/settings/home', keywords: 'start here setup' },
];
