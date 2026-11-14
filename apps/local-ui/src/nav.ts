// W4-SHELL-V2 (Decisions 49–51; W4 UX v2 "three layers"; prototype v23): the app's sections. One
// app, the same routes in both layers: "Under the hood" changes how a screen looks, never which
// screen you are on. The section menu (a minimized rail; a sheet on a phone) holds Home, Agents,
// Activity and Settings; the Advanced group appears only while Under the hood is on. Get started is
// a guided layer over the app (`/start/<step>`), reached from Help, Cmd+K and Home. Every route
// points at today's page; the section builders replace the page bodies in their own folders.
import { PAGE_TITLES } from './strings.js';

export const HOME_PATH = '/';
export const AGENTS_PATH = '/agents';
/** W7-ID-B3 (D-144): the same page under its new name; `/agents` keeps working. */
export const IDS_PATH = '/ids';
export const ACTIVITY_PATH = '/activity';
export const LIVE_ACTIVITY_PATH = '/activity/live';
export const SETTINGS_PATH = '/settings';
/** Where Settings opens (A9: the list of settings, W4-SETTINGS-ADVANCED). */
export const SETTINGS_HOME = '/settings';
/** Get started, step 1 (U2 builds the steps). */
export const START_PATH = '/start/app';
export const START_STEPS = [
  '/start/app',
  '/start/connect',
  '/start/connected',
  '/start/files',
  '/start/invite',
];
/**
 * Interim (until U3 Home and U4 People land): today's Messages and Contacts pages stay reachable
 * from Cmd+K and Home's own links, out of the section menu. Their builders turn these paths into
 * redirects to Home.
 * W6-UI-POLISH: the old Inbox page is gone; its path goes to Home, where each person's files are.
 */
export const LEGACY_INBOX_PATH = '/inbox';
export const INTERIM_PEOPLE_PATH = '/contacts';
/** WP-N1 (design-1112 §2.2): People's own path; `/contacts` stays as an alias that shows the same page. */
export const PEOPLE_PATH = '/people';
/**
 * W4-WIRE: the Invite screen (U4), where every "Invite someone" and "Add contact" leads: Home, the
 * Get started card, Go to, the empty states and the compact window. A fixed marker with no data.
 */
export const INVITE_PATH = `${INTERIM_PEOPLE_PATH}?invite`;
/** W4-WIRE: "Add agent" and "New agent" reuse the Get started steps (one flow, not two). */
export const NEW_AGENT_PATH = '/start/app?add=agent';
/** Advanced, from Settings (the first Advanced page). */
export const ADVANCED_HOME = '/advanced/network';

/** The icons of the section menu (layout/shell-icons.tsx; Lucide, as the prototype). */
export type SectionIcon =
  | 'home'
  | 'agents'
  | 'idcard'
  | 'people'
  | 'activity'
  | 'settings'
  | 'stream'
  | 'rules'
  | 'proofs'
  | 'relays'
  | 'diag'
  | 'map';

export interface Section {
  readonly id: string;
  readonly label: string;
  readonly icon: SectionIcon;
  readonly path: string;
}

/** The section menu, in order (A4/A8/A9). */
export const SECTIONS: readonly Section[] = [
  { id: 'home', label: PAGE_TITLES.home, icon: 'home', path: HOME_PATH },
  { id: 'people', label: PAGE_TITLES.people, icon: 'people', path: PEOPLE_PATH },
  { id: 'agents', label: PAGE_TITLES.agents, icon: 'idcard', path: IDS_PATH },
  { id: 'activity', label: PAGE_TITLES.activity, icon: 'activity', path: ACTIVITY_PATH },
  { id: 'settings', label: PAGE_TITLES.settings, icon: 'settings', path: SETTINGS_HOME },
];

/** The Advanced group: only while Under the hood is on (A10/A11). */
export const ADVANCED_SECTIONS: readonly Section[] = [
  { id: 'live', label: PAGE_TITLES.liveActivity, icon: 'stream', path: LIVE_ACTIVITY_PATH },
  { id: 'network', label: PAGE_TITLES.network, icon: 'relays', path: ADVANCED_HOME },
  {
    id: 'diagnostics',
    label: PAGE_TITLES.diagnostics,
    icon: 'diag',
    path: '/advanced/diagnostics',
  },
  { id: 'map', label: PAGE_TITLES.connectionsMap, icon: 'map', path: '/advanced/map' },
];

export interface SettingsPage {
  readonly label: string;
  readonly path: string;
}

/** Settings (A9), in order; "Advanced" leads to the Advanced pages. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { label: PAGE_TITLES.backupTouchId, path: '/settings/backup' },
  // UX1113 WP-S2: Touch ID & master code (Safety group, design-1112 §3.3).
  { label: PAGE_TITLES.touchId, path: '/settings/touch-id' },
  { label: PAGE_TITLES.apps, path: '/settings/apps' },
  { label: PAGE_TITLES.filesFolder, path: '/settings/files' },
  // REL051-RET1: sizes only (retention plan RET-1).
  { label: PAGE_TITLES.storage, path: '/settings/storage' },
  { label: PAGE_TITLES.appearance, path: '/settings/appearance' },
  // N6 (PLAN-NOTIFY §4.4): replaces the redirect to Settings home.
  { label: PAGE_TITLES.notifications, path: '/settings/notifications' },
  { label: PAGE_TITLES.rules, path: '/settings/rules' },
  { label: PAGE_TITLES.proofs, path: '/settings/proofs' },
  // DESK051-UPD, REL051-UPD2: the app's version and "Check for updates", the one update surface in
  // the desktop app and in the browser app alike (before Advanced).
  { label: PAGE_TITLES.updates, path: '/settings/updates' },
  { label: PAGE_TITLES.advanced, path: '/settings/advanced' },
];

/** The Settings pages. REL051-UPD2: the same in the desktop app and in the browser. */
export function settingsPages(): readonly SettingsPage[] {
  return SETTINGS_PAGES;
}

/** The agent name segment of `/agents/<name>` (the folder name rule: lower case, digits, dashes). */
const AGENT_PAGE = /^\/(?:agents|ids)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The agent of a `/agents/<name>` path, or undefined. */
export function agentNameOf(path: string): string | undefined {
  return AGENT_PAGE.exec(path)?.[1];
}

/** The section a path belongs to (marked current in the menu), or undefined. */
export function sectionOf(path: string): string | undefined {
  if (path === INTERIM_PEOPLE_PATH || path === PEOPLE_PATH) return 'people';
  if (path === HOME_PATH || path.startsWith('/approve/')) return 'home';
  if (path === AGENTS_PATH || path === IDS_PATH || agentNameOf(path) !== undefined) return 'agents';
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
  if (path === INTERIM_PEOPLE_PATH || path === PEOPLE_PATH) return PAGE_TITLES.people;
  if (agentNameOf(path) !== undefined) return PAGE_TITLES.agents;
  const settings = settingsPages().find((p) => p.path === path);
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
  '/settings/home': HOME_PATH,
  [LEGACY_INBOX_PATH]: HOME_PATH,
  '/settings/messages': HOME_PATH,
  '/settings/contacts': PEOPLE_PATH,
  '/settings/agents': AGENTS_PATH,
  '/settings/activity': ACTIVITY_PATH,
  // WP-N1: interim, until WP-C1 (Advanced) builds its page. WP-S2's Touch ID & master code page is
  // real now, so `/settings/touch-id` is no longer redirected.
  '/settings/advanced': ADVANCED_HOME,
  '/settings/about': '/advanced/diagnostics',
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

/** Extra words a section is found by in Cmd+K ("IDs" stays a name for My IDs; "Contacts" for People). */
const SECTION_KEYWORDS: Readonly<Record<string, string>> = {
  people: 'contacts person people',
  agents: 'ids id agents',
  activity: 'history log recent changes',
};

/** UX-LEFT-1 (R1-UI-23): the words people type for a Settings page that its title does not hold. */
const SETTINGS_KEYWORDS: Readonly<Record<string, string>> = {
  '/settings/backup': 'recovery master code restore kit',
  '/settings/touch-id': 'passkey fingerprint password code',
  '/settings/apps': 'ai app connect claude cursor',
  '/settings/files': 'folder inbox send',
  '/settings/storage': 'space size disk delete',
  '/settings/appearance': 'theme dark light mode colour color',
  '/settings/notifications': 'alerts sounds',
  '/settings/rules': 'allow permissions policy',
  '/settings/proofs': 'proof credits',
  '/settings/updates': 'version update upgrade',
  '/settings/advanced': 'help diagnostics relay network pro technical',
};

/** Everything Cmd+K reaches, in the order it lists them (the prototype's palette). */
export function goToEntries(hood: boolean): readonly GoToEntry[] {
  const go = 'Go to';
  const list: GoToEntry[] = [
    ...SECTIONS.map((s) => ({
      label: s.label,
      hint: go,
      path: s.path,
      ...(SECTION_KEYWORDS[s.id] === undefined ? {} : { keywords: SECTION_KEYWORDS[s.id] }),
    })),
    {
      label: 'Invite someone',
      hint: 'Action',
      path: INVITE_PATH,
      keywords: 'contact add person',
    },
    // Files live with each person on Home (their conversation and files).
    { label: PAGE_TITLES.files, hint: go, path: HOME_PATH, keywords: 'inbox messages received' },
    {
      label: 'New ID',
      hint: 'Action',
      path: NEW_AGENT_PATH,
      keywords: 'add agent id create',
    },
    { label: PAGE_TITLES.getStarted, hint: 'Help', path: START_PATH, keywords: 'setup start' },
    {
      label: hood ? 'Turn off Under the hood' : 'Turn on Under the hood',
      hint: '⌘⇧U',
      action: 'hood',
      keywords: 'pro details technical',
    },
    { label: 'Keyboard shortcuts', hint: '⌘/', action: 'shortcuts', keywords: 'keys' },
    ...settingsPages()
      .filter((p) => p.path.startsWith('/settings/'))
      .map((p) => ({
        label: p.label,
        hint: PAGE_TITLES.settings,
        path: p.path,
        ...(SETTINGS_KEYWORDS[p.path] === undefined ? {} : { keywords: SETTINGS_KEYWORDS[p.path] }),
      })),
  ];
  if (hood) {
    for (const s of ADVANCED_SECTIONS) {
      list.push({ label: s.label, hint: PAGE_TITLES.advanced, path: s.path });
    }
  }
  return list;
}
