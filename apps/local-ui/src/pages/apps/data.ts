// U3-i: the AI apps reads parsed defensively, and the card state rules (b11 §30.2). Everything the
// server sends is a fixed word, a fixed app name, a display path or one of AgentLink's own entries;
// it is still rendered as text only and never used to authorise anything (the app id and the
// changeId travel with each request, and the server checks them again).

/** The page's path. The server serves pages under /settings (approval-server.ts APP_PAGE). */
export const APPS_PAGE_PATH = '/settings/apps';

export type StateWord = 'not_connected' | 'connected' | 'not_ours' | 'unreadable';

export interface AppRow {
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly state: StateWord;
  readonly agent?: string;
  readonly quitFirst: boolean;
  /** R2: the server could not check whether the app is open (not the same as "quit first"). */
  readonly checkFailed?: boolean;
  /** WP-D7: the entry starts the AgentLink app's own copy (else `npx`). */
  readonly form?: 'app';
}
/** WP-D7: the AgentLink desktop app on this computer, usable or to be moved first. */
export type DesktopAppWord = 'available' | 'move_first';
export interface AppsList {
  readonly desktopRunning: boolean;
  readonly apps: readonly AppRow[];
  readonly desktopApp?: DesktopAppWord;
}

export interface Entry {
  readonly command: string;
  readonly args: readonly string[];
  readonly [key: string]: unknown;
}
export type ChangeKindWord = 'connect' | 'move' | 'disconnect' | 'switch';
/** WP-D7: the `agentlink` command's change, AgentLink's own text before and after. */
export interface LauncherChange {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}
export interface AppChange {
  readonly kind: ChangeKindWord;
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly folder: string;
  readonly oldEntry: Entry | null;
  readonly newEntry: Entry | null;
  readonly oldAgent: string | null;
  readonly newAgent: string | null;
  readonly changeId: string;
  /** WP-D7: shown and written with the entry (asked for). */
  readonly launcher?: LauncherChange;
  /** WP-D7: the `agentlink` command could be pointed at the app too. */
  readonly launcherOffer?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CHANGE_ID = /^[0-9a-f]{64}$/;
const STATES: ReadonlySet<string> = new Set([
  'not_connected',
  'connected',
  'not_ours',
  'unreadable',
]);
const KINDS: ReadonlySet<string> = new Set(['connect', 'move', 'disconnect', 'switch']);

function parseRow(v: unknown): AppRow | undefined {
  if (
    !isObject(v) ||
    typeof v['app'] !== 'string' ||
    !APP_ID.test(v['app']) ||
    typeof v['name'] !== 'string' ||
    typeof v['path'] !== 'string' ||
    typeof v['state'] !== 'string' ||
    !STATES.has(v['state'])
  ) {
    return undefined;
  }
  const agent = v['agent'];
  if (v['state'] === 'connected' && !(typeof agent === 'string' && AGENT_NAME.test(agent))) {
    return undefined;
  }
  return {
    app: v['app'],
    name: v['name'],
    path: v['path'],
    state: v['state'] as StateWord,
    ...(typeof agent === 'string' && v['state'] === 'connected' ? { agent } : {}),
    quitFirst: v['quitFirst'] === true,
    ...(v['checkFailed'] === true ? { checkFailed: true } : {}),
    ...(v['form'] === 'app' && v['state'] === 'connected' ? { form: 'app' as const } : {}),
  };
}

export function parseApps(value: unknown): AppsList | undefined {
  if (!isObject(value) || !Array.isArray(value['apps'])) return undefined;
  const app = value['desktopApp'];
  return {
    desktopRunning: value['desktopRunning'] === true,
    apps: value['apps'].map(parseRow).filter((r): r is AppRow => r !== undefined),
    ...(app === 'available' || app === 'move_first' ? { desktopApp: app } : {}),
  };
}

function parseLauncher(v: unknown): LauncherChange | null | undefined {
  if (v === undefined) return null;
  if (
    !isObject(v) ||
    typeof v['path'] !== 'string' ||
    typeof v['oldText'] !== 'string' ||
    typeof v['newText'] !== 'string'
  ) {
    return undefined;
  }
  return { path: v['path'], oldText: v['oldText'], newText: v['newText'] };
}

function parseEntry(v: unknown): Entry | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || typeof v['command'] !== 'string' || !Array.isArray(v['args']))
    return undefined;
  if (!v['args'].every((a) => typeof a === 'string')) return undefined;
  return v as unknown as Entry;
}

export type ParsedPreview =
  | { readonly kind: 'change'; readonly change: AppChange }
  | { readonly kind: 'none'; readonly status: string };

export function parsePreview(value: unknown): ParsedPreview | undefined {
  if (!isObject(value) || typeof value['status'] !== 'string') return undefined;
  if (value['status'] !== 'change') return { kind: 'none', status: value['status'] };
  const { kind, app, name, path, folder, changeId } = value;
  const oldEntry = parseEntry(value['oldEntry']);
  const newEntry = parseEntry(value['newEntry']);
  const launcher = parseLauncher(value['launcher']);
  if (
    typeof kind !== 'string' ||
    !KINDS.has(kind) ||
    typeof app !== 'string' ||
    typeof name !== 'string' ||
    typeof path !== 'string' ||
    typeof folder !== 'string' ||
    typeof changeId !== 'string' ||
    !CHANGE_ID.test(changeId) ||
    oldEntry === undefined ||
    newEntry === undefined ||
    launcher === undefined
  ) {
    return undefined;
  }
  const side = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    kind: 'change',
    change: {
      kind: kind as ChangeKindWord,
      app,
      name,
      path,
      folder,
      oldEntry,
      newEntry,
      oldAgent: side(value['oldAgent']),
      newAgent: side(value['newAgent']),
      changeId,
      ...(launcher === null ? {} : { launcher }),
      ...(value['launcherOffer'] === true ? { launcherOffer: true } : {}),
    },
  };
}

/** The entry as the page shows it: `"agentlink": { ... }`, pretty-printed, as text. */
export function entryText(entry: Entry): string {
  return `"agentlink": ${JSON.stringify(entry, null, 2)}`;
}

/** The generic entry for "Not listed? Connect it by hand" (the same shape `init` writes). */
export function genericEntry(folder: string): Entry {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', folder],
    env: {},
  };
}

export type CardState =
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'quit_first' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'another'; readonly agent: string }
  | { readonly kind: 'not_ours' }
  | { readonly kind: 'unreadable' };

/** The state of one card, relative to the open agent, from the read alone (never from a click). */
export function cardState(row: AppRow, open: string | null): CardState {
  switch (row.state) {
    case 'connected':
      return row.agent === open
        ? { kind: 'connected' }
        : { kind: 'another', agent: row.agent ?? '' };
    case 'not_ours':
      return { kind: 'not_ours' };
    case 'unreadable':
      return { kind: 'unreadable' };
    case 'not_connected':
      return row.quitFirst ? { kind: 'quit_first' } : { kind: 'not_connected' };
  }
}
