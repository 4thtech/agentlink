// WP-D3 (desktop plan rev. 1, Decision 2, §2): the private pipe between the desktop app's shell
// (Electron main, apps/desktop) and its core desktop host (this package, dist/desktop/host.js).
//
// SHARED SCHEMA. This module is self-contained on purpose (no imports, no Node API) so that the
// shell's copy (apps/desktop/src/shared/protocol.ts, WP-D2) can be reconciled with it line by line
// at integration; a test there and here should keep the two equal. Until then THIS file is what
// the core accepts and sends.
//
// Transport: the core's inherited fd 3 (a pipe or socket the shell created; never a file or a
// terminal). JSON lines: one UTF-8 JSON object per line, ended by "\n", at most MAX_PIPE_LINE_BYTES
// bytes before the "\n". Every message carries `v: 1` and `type`, and EXACTLY the keys listed for its
// type (no extra key, no missing key, no prototype trick). Anything else is rejected and dropped
// without echoing any of it anywhere.
//
// Core -> shell:
//   {"v":1,"type":"ready","sessionUrl":"http://localhost:<port>/<path>?t=<43 base64url>"}
//       A fresh one-shot session link for the window (BrowserWindow.loadURL only). Sent once the
//       host listens, and again whenever the core opens a page (a `show`, an accepted `invite`, a
//       terminal `agentlink join` handing an invite over). <path> is one of SESSION_PATHS. The link
//       exists only on this pipe: never stdout, stderr, a log, a file, a title or a notification.
//   {"v":1,"type":"status","state":"starting|running|closing","counts":{"openPages":n,"waitingApprovals":n}}
//       Numbers and fixed states only (tray). Sent when any of them changes.
//   {"v":1,"type":"approval-waiting","count":n}
//       Requests waiting for the owner (a notification with no text). Sent when the count changes.
//   {"v":1,"type":"invite-result","outcome":<INVITE_OUTCOMES>}            (proposed at WP-D3)
//       What happened to the shell's last `invite` (a fixed word; never the link or the name).
//   {"v":1,"type":"stopped","reason":<STOP_REASONS>}                      (proposed at WP-D3)
//       The last message before the core exits.
//   {"v":1,"type":"app-update-check"}                                       (DESK051-UPD)
//       The person chose "Check for updates" in Settings. No other key.
//   {"v":1,"type":"notify","kind":<NOTIFY_KINDS>,"count":n,"name":""|<owner alias>}   (N7)
//       Raise one native notification: a fixed code; the shell builds every word and opens only
//       the kind's fixed route on a click. `count` >= 1. `name` is "" except on messages and files,
//       and only while the owner turned on Show names: then an alias the OWNER gave the contact
//       (nameSource 'owner', never a self-declared name), in the plain NOTIFY_NAME shape. Sent only
//       for the kinds the owner switched on (Settings > Notifications). Never message text, a file
//       name, a link or anything inbound (I-5).
//
// Shell -> core:
//   {"v":1,"type":"invite","link":"https://agentlink.4thtech.io/i#…"}
//       The canonical invite link the shell rebuilt from `agentlink://join#…` (08 §4 pattern; the
//       short form too). The core checks it again (Accept step 1) and holds it in memory only.
//   {"v":1,"type":"show","route":<SHOW_ROUTES>}
//       Open a page in the window (a fresh `ready` follows). A fixed enum, never a path. N7: `inbox`
//       (Home, a click on a message or file notification) and `updates` (Settings > Updates).
//   {"v":1,"type":"shutdown"}
//       Close the server (which removes app-host.json) and exit 0.
//   {"v":1,"type":"app-update","state":<APP_UPDATE_STATES>,"current":"<v>","latest":"<v>"|"","download":"<link>"|""}
//       DESK051-UPD: what Settings > Updates shows (the shell's app-update.ts builds it). `latest` and
//       `download` only for "available": a plain x.y.z newer than `current`, and exactly this
//       repository's release file for it (AgentLink-<v>-mac-<arm64|x64>.dmg) or its release page.

/** The protocol version every message carries. */
export const DESKTOP_PIPE_VERSION = 1;

/** The longest line accepted (an invite link is at most ~21.9 k characters). */
export const MAX_PIPE_LINE_BYTES = 32 * 1024;

/**
 * `show` routes: Home (first run while no owner exists), the approvals list, the join screen; N7:
 * inbox (Home, where the people are) and updates (Settings > Updates).
 */
export const SHOW_ROUTES = Object.freeze([
  'home',
  'approvals',
  'join',
  'inbox',
  'updates',
] as const);
export type ShowRoute = (typeof SHOW_ROUTES)[number];

/** N7: the kinds a native notification can be about (the notification store's kinds that alert). */
export const NOTIFY_KINDS = Object.freeze(['approvals', 'messages', 'files', 'update'] as const);
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
/** N7: the kinds that may carry an owner-given name. */
export const NOTIFY_NAME_KINDS: readonly NotifyKind[] = Object.freeze(['messages', 'files']);
/** N7: the longest name, in code points (06 §2.1's restricted length). */
export const NOTIFY_NAME_MAX_CODE_POINTS = 32;
/** N7: letters, marks, numbers, single spaces, apostrophes and hyphens; starts with a letter or number. */
const NOTIFY_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}'\u2019-]| (?! ))*$/u;

/** N7: true for a name the pipe may carry in `notify.name` (non-empty; the shell's rule). */
export function isNotifyName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if ([...value].length > NOTIFY_NAME_MAX_CODE_POINTS) return false;
  if (value.endsWith(' ')) return false;
  return NOTIFY_NAME.test(value);
}

/** The core's states, as the tray shows them. */
export const HOST_STATES = Object.freeze(['starting', 'running', 'closing'] as const);
export type HostState = (typeof HOST_STATES)[number];

/** What happened to an `invite` (fixed words, 11 §5 copy lives in the shell). */
export const INVITE_OUTCOMES = Object.freeze([
  /** Held as the waiting invite; a `ready` for the join screen (or first run) follows. */
  'waiting',
  /** Another invite is already waiting in the app. */
  'invite_waiting',
  /** Not a complete AgentLink invite. */
  'refused',
  'expired',
  /** A short link that is gone (used, cancelled or expired). */
  'unavailable',
  /** A short link that could not be fetched. */
  'unreachable',
  'failed',
] as const);
export type InviteOutcome = (typeof INVITE_OUTCOMES)[number];

/** Why the core stopped. The first seven are `ui`'s start failures (R1). */
export const STOP_REASONS = Object.freeze([
  'no_owner',
  'no_ids',
  'only_removing',
  'port',
  'keychain',
  'open',
  'failed',
  /** The shell sent `shutdown`. */
  'shutdown',
  /** The pipe closed (the shell is gone). */
  'pipe_closed',
  /** SIGTERM, SIGINT or SIGHUP. */
  'signal',
  /** An error the server could not serve through (ui-lifecycle.ts). */
  'fatal',
] as const);
export type StopReason = (typeof STOP_REASONS)[number];

/** DESK051-UPD: what Settings > Updates can show (the shell's app-update.ts APP_UPDATE_STATES). */
export const APP_UPDATE_STATES = Object.freeze([
  'off',
  'idle',
  'checking',
  'current',
  'available',
  'failed',
  'offline',
] as const);
export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

/** DESK051-UPD: the update state the shell sends (checked field by field, see isAppUpdate). */
export interface AppUpdateView {
  readonly state: AppUpdateState;
  readonly current: string;
  readonly latest: string;
  readonly download: string;
}

const UPD_NUM = '(0|[1-9][0-9]{0,5})';
const RELEASE_VERSION = new RegExp(`^${UPD_NUM}\\.${UPD_NUM}\\.${UPD_NUM}$`);
const APP_VERSION = new RegExp(
  `^${UPD_NUM}\\.${UPD_NUM}\\.${UPD_NUM}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$`,
);
const RELEASES = 'https://github.com/4thtech/agentlink/releases';

/** True only when both are plain x.y.z and `latest` is strictly greater. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(latest);
  const b = RELEASE_VERSION.exec(current);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

/** True when `url` is exactly one of the links the shell builds for `version`. */
export function isUpdateLinkFor(url: unknown, version: string): boolean {
  if (typeof url !== 'string' || !RELEASE_VERSION.test(version)) return false;
  return (
    url === `${RELEASES}/download/v${version}/AgentLink-${version}-mac-arm64.dmg` ||
    url === `${RELEASES}/download/v${version}/AgentLink-${version}-mac-x64.dmg` ||
    url === `${RELEASES}/tag/v${version}`
  );
}

/** The four fields fit together: a version and a link only when available. */
export function isAppUpdate(value: Readonly<Record<string, unknown>>): boolean {
  const { state, current, latest, download } = value;
  if (!isOneOf(APP_UPDATE_STATES, state)) return false;
  if (typeof current !== 'string' || !APP_VERSION.test(current)) return false;
  if (state === 'available') {
    return (
      typeof latest === 'string' &&
      isNewerVersion(latest, current) &&
      isUpdateLinkFor(download, latest)
    );
  }
  return latest === '' && download === '';
}

/** The session link paths the core may send (approval-server.ts open*, invite-paths.ts). */
export const SESSION_PATHS = Object.freeze([
  '/',
  '/first-run',
  '/settings/home',
  '/settings/join',
  // N7: a click on an "Update ready" notification.
  '/settings/updates',
] as const);

const SESSION_URL =
  /^http:\/\/localhost:([1-9][0-9]{0,4})(\/|\/first-run|\/settings\/home|\/settings\/join|\/settings\/updates)\?t=[A-Za-z0-9_-]{43}$/;

/** 08 §4: the canonical invite (join.ts CANONICAL; a test keeps them equal). */
const INVITE_CANONICAL = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]{1,21846}$/;
/** W4-SHORT-INVITE: the short form (join.ts SHORT). */
const INVITE_SHORT = /^https:\/\/agentlink\.4thtech\.io\/i#2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface HostCounts {
  readonly openPages: number;
  readonly waitingApprovals: number;
}

export type HostMessage =
  | { readonly v: 1; readonly type: 'ready'; readonly sessionUrl: string }
  | {
      readonly v: 1;
      readonly type: 'status';
      readonly state: HostState;
      readonly counts: HostCounts;
    }
  | { readonly v: 1; readonly type: 'approval-waiting'; readonly count: number }
  | { readonly v: 1; readonly type: 'invite-result'; readonly outcome: InviteOutcome }
  | { readonly v: 1; readonly type: 'stopped'; readonly reason: StopReason }
  | { readonly v: 1; readonly type: 'app-update-check' }
  | NotifyMessage;

/** N7: one native notification as a fixed code. */
export interface NotifyMessage {
  readonly v: 1;
  readonly type: 'notify';
  readonly kind: NotifyKind;
  readonly count: number;
  /** "" or an owner-given alias (messages, files only). */
  readonly name: string;
}

export type ShellMessage =
  | { readonly v: 1; readonly type: 'invite'; readonly link: string }
  | { readonly v: 1; readonly type: 'show'; readonly route: ShowRoute }
  | { readonly v: 1; readonly type: 'shutdown' }
  | ({ readonly v: 1; readonly type: 'app-update' } & AppUpdateView);

/** True for a session link the core may send (and the shell may load). */
export function isSessionUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SESSION_URL.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

/** True for a canonical or short invite link, exactly (no quotes, no spaces, nothing trimmed). */
export function isInviteLink(value: unknown): value is string {
  return typeof value === 'string' && (INVITE_CANONICAL.test(value) || INVITE_SHORT.test(value));
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** A plain JSON object with exactly `keys` (own, enumerable), else undefined. */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  if (own.length !== want.length || own.some((k, i) => k !== want[i])) return undefined;
  return value as Record<string, unknown>;
}

/** One line (without its "\n") as a JSON value, or undefined (too long, not JSON). */
function parseLine(line: string): unknown {
  // Bytes, not characters: a cheap upper bound first, then the exact UTF-8 length.
  if (line.length > MAX_PIPE_LINE_BYTES) return undefined;
  if (new TextEncoder().encode(line).length > MAX_PIPE_LINE_BYTES) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** The shell's message on one line, or undefined for anything that is not exactly one. */
export function parseShellMessage(line: string): ShellMessage | undefined {
  const value = parseLine(line);
  const head = typeof value === 'object' && value !== null ? (value as { type?: unknown }) : {};
  switch (head.type) {
    case 'invite': {
      const m = exactObject(value, ['v', 'type', 'link']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isInviteLink(m['link'])) return undefined;
      return Object.freeze({ v: 1, type: 'invite', link: m['link'] });
    }
    case 'show': {
      const m = exactObject(value, ['v', 'type', 'route']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isOneOf(SHOW_ROUTES, m['route'])) return undefined;
      return Object.freeze({ v: 1, type: 'show', route: m['route'] });
    }
    case 'shutdown': {
      const m = exactObject(value, ['v', 'type']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION) return undefined;
      return Object.freeze({ v: 1, type: 'shutdown' });
    }
    case 'app-update': {
      const m = exactObject(value, ['v', 'type', 'state', 'current', 'latest', 'download']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isAppUpdate(m)) return undefined;
      return Object.freeze({
        v: 1,
        type: 'app-update',
        state: m['state'] as AppUpdateState,
        current: m['current'] as string,
        latest: m['latest'] as string,
        download: m['download'] as string,
      });
    }
    default:
      return undefined;
  }
}

/** The core's message on one line, or undefined (the shell's parser; tests use it here). */
export function parseHostMessage(line: string): HostMessage | undefined {
  const value = parseLine(line);
  const head = typeof value === 'object' && value !== null ? (value as { type?: unknown }) : {};
  switch (head.type) {
    case 'ready': {
      const m = exactObject(value, ['v', 'type', 'sessionUrl']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isSessionUrl(m['sessionUrl'])) return undefined;
      return Object.freeze({ v: 1, type: 'ready', sessionUrl: m['sessionUrl'] });
    }
    case 'status': {
      const m = exactObject(value, ['v', 'type', 'state', 'counts']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isOneOf(HOST_STATES, m['state'])) return undefined;
      const c = exactObject(m['counts'], ['openPages', 'waitingApprovals']);
      if (c === undefined || !isCount(c['openPages']) || !isCount(c['waitingApprovals'])) {
        return undefined;
      }
      return Object.freeze({
        v: 1,
        type: 'status',
        state: m['state'],
        counts: Object.freeze({
          openPages: c['openPages'],
          waitingApprovals: c['waitingApprovals'],
        }),
      });
    }
    case 'approval-waiting': {
      const m = exactObject(value, ['v', 'type', 'count']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isCount(m['count'])) return undefined;
      return Object.freeze({ v: 1, type: 'approval-waiting', count: m['count'] });
    }
    case 'invite-result': {
      const m = exactObject(value, ['v', 'type', 'outcome']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isOneOf(INVITE_OUTCOMES, m['outcome'])) {
        return undefined;
      }
      return Object.freeze({ v: 1, type: 'invite-result', outcome: m['outcome'] });
    }
    case 'stopped': {
      const m = exactObject(value, ['v', 'type', 'reason']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isOneOf(STOP_REASONS, m['reason'])) {
        return undefined;
      }
      return Object.freeze({ v: 1, type: 'stopped', reason: m['reason'] });
    }
    case 'app-update-check': {
      const m = exactObject(value, ['v', 'type']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION) return undefined;
      return Object.freeze({ v: 1, type: 'app-update-check' });
    }
    case 'notify': {
      const m = exactObject(value, ['v', 'type', 'kind', 'count', 'name']);
      if (m?.['v'] !== DESKTOP_PIPE_VERSION || !isOneOf(NOTIFY_KINDS, m['kind'])) return undefined;
      const kind = m['kind'];
      const count = m['count'];
      const name = m['name'];
      if (!isCount(count) || count < 1 || typeof name !== 'string') return undefined;
      if (name !== '' && (!NOTIFY_NAME_KINDS.includes(kind) || !isNotifyName(name))) {
        return undefined;
      }
      return Object.freeze({ v: 1, type: 'notify', kind, count, name });
    }
    default:
      return undefined;
  }
}

/**
 * One core message as its line (with "\n"), or undefined when it is not a valid message (so a bad
 * value, such as a session link that is not one, never reaches the pipe).
 */
export function encodeHostMessage(message: HostMessage): string | undefined {
  const line = JSON.stringify(message);
  return parseHostMessage(line) === undefined ? undefined : `${line}\n`;
}

/** One shell message as its line (tests; the shell's own writer). */
export function encodeShellMessage(message: ShellMessage): string | undefined {
  const line = JSON.stringify(message);
  return parseShellMessage(line) === undefined ? undefined : `${line}\n`;
}
