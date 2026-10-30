// W4-SHELL-V2 (Decisions 49–51; W4 UX v2 "three layers"; prototype v23): the app's sections. One
// app, the same routes in both layers: "Under the hood" changes how a screen looks, never which
// screen you are on. The section menu (a minimized rail; a sheet on a phone) holds Home, Agents,
// Activity and Settings; the Advanced group appears only while Under the hood is on. Get started is
// a guided layer over the app (`/start/<step>`), reached from Help, Cmd+K and Home. Every route
// points at today's page; the section builders replace the page bodies in their own folders.
import { PAGE_TITLES } from './strings.js';

export const HOME_PATH = '/';
export const AGENTS_PATH = '/agents';
export const ACTIVITY_PATH = '/activity';
export const LIVE_ACTIVITY_PATH = '/activity/live';
export const SETTINGS_PATH = '/settings';
/** Where Settings opens (A9: the first entry). */
export const SETTINGS_HOME = '/settings/backup';
/** Get started, step 1 (U2 builds the steps). */
export const START_PATH = '/start/app';
export const START_STEPS = ['/start/app', '/start/connect', '/start/connected', '/start/invite'];
/**
 * Interim (until U3 Home and U4 People land): today's Messages and Contacts pages stay reachable
 * from Cmd+K and Home's own links, out of the section menu. Their builders turn these paths into
 * redirects to Home.
 */
export const INTERIM_MESSAGES_PATH = '/inbox';
export const INTERIM_PEOPLE_PATH = '/contacts';
/** Advanced, from Settings (the first Advanced page). */
export const ADVANCED_HOME = '/advanced/network';

/** The icons of the section menu (layout/shell-icons.tsx; Lucide, as the prototype). */
export type SectionIcon =
  'home' | 'agents' | 'activity' | 'settings' | 'stream' | 'rules' | 'proofs' | 'relays' | 'diag';

export interface Section {
  readonly id: string;
  readonly label: string;
  readonly icon: SectionIcon;
  readonly path: string;
}

/** The section menu, in order (A4/A8/A9). */
export const SECTIONS: readonly Section[] = [
  { id: 'home', label: PAGE_TITLES.home, icon: 'home', path: HOME_PATH },
  { id: 'agents', label: PAGE_TITLES.agents, icon: 'agents', path: AGENTS_PATH },
  { id: 'activity', label: PAGE_TITLES.activity, icon: 'activity', path: ACTIVITY_PATH },
  { id: 'settings', label: PAGE_TITLES.settings, icon: 'settings', path: SETTINGS_HOME },
];

/** The Advanced group: only while Under the hood is on (A10/A11). */
export const ADVANCED_SECTIONS: readonly Section[] = [
  { id: 'live', label: PAGE_TITLES.liveActivity, icon: 'stream', path: LIVE_ACTIVITY_PATH },
  { id: 'rules', label: PAGE_TITLES.rules, icon: 'rules', path: '/advanced/rules' },
  { id: 'proofs', label: PAGE_TITLES.proofs, icon: 'proofs', path: '/advanced/proofs' },
  { id: 'network', label: PAGE_TITLES.network, icon: 'relays', path: ADVANCED_HOME },
  {
    id: 'diagnostics',
    label: PAGE_TITLES.diagnostics,
    icon: 'diag',
    path: '/advanced/diagnostics',
  },
];

export interface SettingsPage {
  readonly label: string;
  readonly path: string;
}

/** Settings (A9), in order; "Advanced" leads to the Advanced pages. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { label: PAGE_TITLES.backupTouchId, path: '/settings/backup' },
  { label: PAGE_TITLES.apps, path: '/settings/apps' },
  { label: PAGE_TITLES.filesFolder, path: '/settings/files' },
  { label: PAGE_TITLES.appearance, path: '/settings/appearance' },
  { label: PAGE_TITLES.notifications, path: '/settings/notifications' },
  { label: PAGE_TITLES.rules, path: '/settings/rules' },
  { label: PAGE_TITLES.proofs, path: '/settings/proofs' },
  { label: PAGE_TITLES.advanced, path: ADVANCED_HOME },
];

/** The agent name segment of `/agents/<name>` (the folder name rule: lower case, digits, dashes). */
const AGENT_PAGE = /^\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The agent of a `/agents/<name>` path, or undefined. */
export function agentNameOf(path: string): string | undefined {
  return AGENT_PAGE.exec(path)?.[1];
}

/** The section a path belongs to (marked current in the menu), or undefined. */
export function sectionOf(path: string): string | undefined {
  if (
    path === HOME_PATH ||
    path.startsWith('/approve/') ||
    path === INTERIM_MESSAGES_PATH ||
    path === INTERIM_PEOPLE_PATH
  ) {
    return 'home';
  }
  if (path === AGENTS_PATH || agentNameOf(path) !== undefined) return 'agents';
  if (path === LIVE_ACTIVITY_PATH) return 'live';
  if (path === ACTIVITY_PATH) return 'activity';
  const advanced = ADVANCED_SECTIONS.find((s) => s.path === path);
  if (advanced !== undefined) return advanced.id;
  if (path === SETTINGS_PATH || path.startsWith('/settings/')) return 'settings';
  return undefined;
}

/** The title of a path (the phone menu button and the document title). */
export function titleOf(path: string): string {
  if (path.startsWith('/start/')) return PAGE_TITLES.getStarted;
  if (path === INTERIM_MESSAGES_PATH) return PAGE_TITLES.messages;
  if (path === INTERIM_PEOPLE_PATH) return PAGE_TITLES.people;
  if (agentNameOf(path) !== undefined) return PAGE_TITLES.agents;
  const settings = SETTINGS_PAGES.find((p) => p.path === path);
  if (settings !== undefined && path.startsWith('/settings/')) return settings.label;
  const section = [...SECTIONS, ...ADVANCED_SECTIONS].find((s) => s.path === path);
  if (section !== undefined) return section.label;
  const id = sectionOf(path);
  const owner = [...SECTIONS, ...ADVANCED_SECTIONS].find((s) => s.id === id);
  return owner?.label ?? PAGE_TITLES.home;
}

/**
 * Old paths that still work and where they now go (deep links, bookmarks, the CLI's links and
 * today's pages' own links until their builders move them).
 */
export const REDIRECTS: Readonly<Record<string, string>> = {
  '/first-run': START_PATH,
  '/start': START_PATH,
  '/settings': SETTINGS_HOME,
  '/settings/home': HOME_PATH,
  '/settings/messages': INTERIM_MESSAGES_PATH,
  '/settings/contacts': INTERIM_PEOPLE_PATH,
  '/settings/agents': AGENTS_PATH,
  '/settings/activity': ACTIVITY_PATH,
  '/settings/advanced': ADVANCED_HOME,
  '/settings/about': '/advanced/diagnostics',
  '/settings/storage': '/settings/files',
  '/settings/passkeys': '/settings/backup',
  '/advanced': ADVANCED_HOME,
};

/** What a Cmd+K entry does: go to a path, or one of the shell's own actions. */
export type GoToAction = 'hood' | 'shortcuts';

/** One entry of Cmd+K: a name and where it goes (or what it does). */
export interface GoToEntry {
  readonly label: string;
  readonly hint: string;
  readonly path?: string;
  readonly action?: GoToAction;
  /** Extra words it is found by. */
  readonly keywords?: string;
}

/** Everything Cmd+K reaches, in the order it lists them (the prototype's palette). */
export function goToEntries(hood: boolean): readonly GoToEntry[] {
  const go = 'Go to';
  const list: GoToEntry[] = [
    ...SECTIONS.map((s) => ({ label: s.label, hint: go, path: s.path })),
    {
      label: 'Invite someone',
      hint: 'Action',
      path: INTERIM_PEOPLE_PATH,
      keywords: 'contact add person',
    },
    { label: PAGE_TITLES.people, hint: go, path: INTERIM_PEOPLE_PATH, keywords: 'contacts' },
    { label: PAGE_TITLES.messages, hint: go, path: INTERIM_MESSAGES_PATH, keywords: 'inbox files' },
    {
      label: 'New agent',
      hint: 'Action',
      path: `${AGENTS_PATH}?add=1`,
      keywords: 'add agent create',
    },
    { label: PAGE_TITLES.getStarted, hint: 'Help', path: START_PATH, keywords: 'setup start' },
    {
      label: hood ? 'Turn off Under the hood' : 'Turn on Under the hood',
      hint: '⌘⇧U',
      action: 'hood',
      keywords: 'pro details technical',
    },
    { label: 'Keyboard shortcuts', hint: '⌘/', action: 'shortcuts', keywords: 'keys' },
    ...SETTINGS_PAGES.filter((p) => p.path.startsWith('/settings/')).map((p) => ({
      label: p.label,
      hint: PAGE_TITLES.settings,
      path: p.path,
    })),
  ];
  if (hood) {
    for (const s of ADVANCED_SECTIONS) {
      list.push({ label: s.label, hint: PAGE_TITLES.advanced, path: s.path });
    }
  }
  return list;
}
