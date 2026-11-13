// The private pipe between the desktop shell (Electron main, apps/desktop) and the core desktop host
// (bundled Node, apps/cli/src/desktop/host.ts). Plan 2026-11-12 Decision 2 and §2; WP-D2 / WP-D3.
//
// ------------------------------------------------------------------------------------------------
// PIPE PROTOCOL v1. Reconciled with WP-D3's apps/cli/src/desktop/protocol.ts (desktop/wp-d3 @
// 7a638fb7): same messages, keys, enums and limits; change both sides together.
// ------------------------------------------------------------------------------------------------
// Transport
// - The shell spawns the core with stdio [ignore, ignore, ignore, pipe]: the pipe is the core's
//   inherited fd 3 and nothing else. stdin, stdout and stderr are not read. The core refuses to start
//   the desktop host without fd 3 (it prints one fixed line and exits).
// - Framing: UTF-8 JSON, one object per line, each line ends with "\n" (0x0A). No "\r", no empty
//   lines, no whitespace before "{" or after "}". A line is at most MAX_LINE_BYTES bytes, newline
//   excluded; the reader checks the size BEFORE decoding or parsing. Invalid UTF-8 is a violation.
// - Every message is a JSON object with EXACTLY the keys listed for its type (no extra, no missing),
//   always including "v": 1 and "type". Values have fixed types; counts are safe integers in
//   0..MAX_COUNT. Duplicate keys are not allowed (the parser cannot see them, so a writer must never
//   produce them).
// - Strictness: any line that is not a valid message of the direction it travels in (unknown type,
//   unknown or missing key, wrong value, oversize, bad UTF-8, bad framing) is a PROTOCOL VIOLATION.
//   The receiver drops the message and closes the pipe; the shell then stops the core (and the
//   supervisor may start a new one). Nothing from a rejected line is logged or echoed.
// - Never on the pipe: keys, seeds, master codes, passphrases, message text, file names, links in a
//   notification, and contact names with ONE exception: N7's `notify.name`, an alias the owner gave
//   a contact (never a self-declared name), only while the owner turned on Show names, and only in
//   the plain NOTIFY_NAME shape (letters, numbers, spaces, ' and -; at most 32 characters).
//   The session link (`ready.sessionUrl`) and an invite link are the only secrets that travel here,
//   and neither is ever logged, put in a title, a notification or a file by either side.
//
// Core -> shell
//   {"v":1,"type":"ready","sessionUrl":"http://localhost:<port><path>?t=<token>"}
//       A new one-shot session link (approval-server mintLink). The shell only hands it to
//       BrowserWindow.loadURL. Sent once the app host listens, and again whenever the core opens a
//       page (a "show", an accepted "invite", a terminal `agentlink join` handing over). <port>
//       1..65535 without leading zeros; <path> is one of SESSION_PATHS; <token> is 43 base64url.
//       Every "ready" of one core process must carry the same origin; the shell locks the window to
//       the first one.
//   {"v":1,"type":"status","state":<HOST_STATES>,"counts":{"openPages":n,"waitingApprovals":n}}
//       Numbers and a state only (tray). Sent when any of them changes.
//   {"v":1,"type":"approval-waiting","count":n}
//       Requests waiting for the owner (n >= 0; sent when the count changes). No summary, no names.
//   {"v":1,"type":"invite-result","outcome":<INVITE_OUTCOMES>}
//       What happened to the shell's last "invite" (a fixed word; never the link or a name).
//   {"v":1,"type":"stopped","reason":<STOP_REASONS>}
//       The last message before the core exits.
//   {"v":1,"type":"app-update-check"}
//       DESK051-UPD: the person chose "Check for updates" in Settings. No other key: the shell checks
//       its one fixed source and answers with an "app-update".
//   {"v":1,"type":"notify","kind":<NOTIFY_KINDS>,"count":n,"name":""|<owner alias>}
//       N7 (PLAN-NOTIFY §3.5): raise one native notification. A fixed code only: the shell builds
//       every word from `kind` (notify.ts), opens only that kind's fixed route on a click and
//       throttles one per kind per 30 s. `count` 1..MAX_COUNT: approvals waiting (approvals), new
//       ones since the last notify (messages, files), 1 (update). `name` is "" except on messages
//       and files, where it may be the owner-given alias (see "Never on the pipe" above). The core
//       sends it only for the kinds the owner switched on (Settings > Notifications).
//   {"v":1,"type":"app-update-install"}
//       UPD-5: the person chose "Update now" (owner session + CSRF in the page). No other key: the
//       shell installs only the update it verified itself (updater/in-app.ts), if any.
//   {"v":1,"type":"app-update-restart"}
//       UPD-5: the person chose "Restart now". No other key: the shell restarts only when its own
//       update is ready.
//
// Shell -> core
//   {"v":1,"type":"invite","link":"https://agentlink.4thtech.io/i#<payload>"}
//       An invite from an agentlink:// link, already rebuilt to the canonical link (WP-D9). <payload>
//       is the short form "2." + 43 base64url characters (last one with zero trailing bits) or the
//       long form of 1..21846 base64url characters (packages/core invite-link.ts). The core keeps it
//       in memory as the waiting invite and answers with a "ready" for the join page.
//   {"v":1,"type":"show","route":<SHOW_ROUTES>}
//       The person asked for a page (tray, dock, second launch, a click on a notification). The core answers with a "ready"
//       carrying a fresh session link for that route's fixed path.
//   {"v":1,"type":"app-update","state":<APP_UPDATE_STATES>,"current":"<v>","latest":"<v>"|"","download":"<link>"|"","installable":<bool>,"percent":<0..100>}
//       DESK051-UPD: what Settings > Updates shows. Sent after every "ready" and whenever it changes.
//       `current` is this app's version (x.y.z, optionally a short build suffix); `latest` and
//       `download` are set only for "available" and the UPD-5 states (downloading, verifying,
//       ready, restarting, install_failed): `latest` is a plain x.y.z newer than `current` and
//       `download` is exactly the release file for this Mac (or the release page) that the shell
//       built from it (app-update.ts). Both are empty otherwise. UPD-5: `installable` (Update now
//       can run here) and `percent` (a whole number, only while downloading); see
//       app-update.ts isAppUpdatePipeView.
//   {"v":1,"type":"shutdown"}
//       Close cleanly (close the agent, the server and the relays) and exit 0. The shell kills the
//       core if it has not exited within its grace period.
// ------------------------------------------------------------------------------------------------
//
// This module is pure (no Node or Electron APIs) so both sides and their tests can use it.

import { isAppUpdatePipeView, type AppUpdatePipeView } from './app-update.js';

/** Protocol version carried in every message as `"v": 1`. */
export const PROTOCOL_VERSION = 1;

/** Longest line in bytes, newline excluded (a long-form invite is about 21.9k characters). */
export const MAX_LINE_BYTES = 32 * 1024;

/** Largest count a status or approval-waiting message may carry. */
export const MAX_COUNT = 1_000_000;

/** The session link paths the core may send (approval-server.ts open*, invite-paths.ts). */
export const SESSION_PATHS = [
  '/',
  '/first-run',
  '/settings/home',
  '/settings/join',
  // N7: a click on an "Update ready" notification (show `updates`).
  '/settings/updates',
] as const;

/** The core's states the tray can show (numbers and states only). */
export const HOST_STATES = ['starting', 'running', 'closing'] as const;
export type HostState = (typeof HOST_STATES)[number];

/** What happened to an "invite" (fixed words; the copy lives in the shell). */
export const INVITE_OUTCOMES = [
  'waiting',
  'invite_waiting',
  'refused',
  'expired',
  'unavailable',
  'unreachable',
  'failed',
] as const;
export type InviteOutcome = (typeof INVITE_OUTCOMES)[number];

/** Why the core stopped (the first seven are `ui`'s start failures). */
export const STOP_REASONS = [
  'no_owner',
  'no_ids',
  'only_removing',
  'port',
  'keychain',
  'open',
  'failed',
  'shutdown',
  'pipe_closed',
  'signal',
  'fatal',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * The stop reasons that mean the core could not start and a restart cannot fix it: the supervisor
 * stops restarting (terminal "failed"); only the person retries (tray). `port` and `failed` may be
 * passing, so they keep the normal backoff.
 */
export const START_FAILURE_REASONS = [
  'no_owner',
  'no_ids',
  'only_removing',
  'keychain',
  'open',
] as const satisfies readonly StopReason[];
export type StartFailureReason = (typeof START_FAILURE_REASONS)[number];

export function isStartFailure(reason: StopReason): reason is StartFailureReason {
  return (START_FAILURE_REASONS as readonly StopReason[]).includes(reason);
}

/** The pages the shell may ask the core to open; the core maps each to a fixed path. */
// N7: `inbox` (a new message or file: Home, where the people are) and `updates` (Settings › Updates).
export const SHOW_ROUTES = ['home', 'approvals', 'join', 'inbox', 'updates'] as const;
export type ShowRoute = (typeof SHOW_ROUTES)[number];

/** N7: the kinds a native notification can be about (the notification store's kinds that alert). */
export const NOTIFY_KINDS = ['approvals', 'messages', 'files', 'update'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
/** N7: the kinds that may carry an owner-given name. */
export const NOTIFY_NAME_KINDS: readonly NotifyKind[] = ['messages', 'files'];
/** N7: the longest name, in code points (06 §2.1's restricted length). */
export const NOTIFY_NAME_MAX_CODE_POINTS = 32;
/**
 * N7: a plain name: starts and ends with a letter or number; letters, marks, numbers, single spaces,
 * apostrophes and hyphens between. No dot, slash, colon, @, angle bracket, control, bidi or
 * zero-width character, so it cannot read as a link, an address or a second line.
 */
const NOTIFY_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}'\u2019-]| (?! ))*$/u;

/** N7: true for a name the pipe may carry in `notify.name` (non-empty). */
export function isNotifyName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if ([...value].length > NOTIFY_NAME_MAX_CODE_POINTS) return false;
  if (value.endsWith(' ')) return false;
  return NOTIFY_NAME.test(value);
}

/** The canonical invite link prefix (packages/core INVITE_LINK_PREFIX; 04 §3.6). */
export const INVITE_LINK_PREFIX = 'https://agentlink.4thtech.io/i#';
/** Longest long-form invite payload (packages/core INVITE_MAX_PAYLOAD_CHARS). */
export const INVITE_MAX_PAYLOAD_CHARS = 21_846;

export interface ReadyMessage {
  readonly v: 1;
  readonly type: 'ready';
  readonly sessionUrl: string;
}
export interface StatusMessage {
  readonly v: 1;
  readonly type: 'status';
  readonly state: HostState;
  readonly counts: { readonly openPages: number; readonly waitingApprovals: number };
}
export interface ApprovalWaitingMessage {
  readonly v: 1;
  readonly type: 'approval-waiting';
  readonly count: number;
}
export interface InviteResultMessage {
  readonly v: 1;
  readonly type: 'invite-result';
  readonly outcome: InviteOutcome;
}
export interface StoppedMessage {
  readonly v: 1;
  readonly type: 'stopped';
  readonly reason: StopReason;
}
/** DESK051-UPD: the person asked for an update check (no other key). */
export interface AppUpdateCheckMessage {
  readonly v: 1;
  readonly type: 'app-update-check';
}
/** N7: one native notification, as a fixed code (no text; see the spec above). */
export interface NotifyMessage {
  readonly v: 1;
  readonly type: 'notify';
  readonly kind: NotifyKind;
  readonly count: number;
  /** "" or an owner-given alias (messages, files only). */
  readonly name: string;
}
/** UPD-5: "Update now" and "Restart now" (no other key). */
export interface AppUpdateStepMessage {
  readonly v: 1;
  readonly type: 'app-update-install' | 'app-update-restart';
}
export type CoreMessage =
  | NotifyMessage
  | ReadyMessage
  | StatusMessage
  | ApprovalWaitingMessage
  | InviteResultMessage
  | StoppedMessage
  | AppUpdateCheckMessage
  | AppUpdateStepMessage;

export interface InviteMessage {
  readonly v: 1;
  readonly type: 'invite';
  readonly link: string;
}
export interface ShowMessage {
  readonly v: 1;
  readonly type: 'show';
  readonly route: ShowRoute;
}
export interface ShutdownMessage {
  readonly v: 1;
  readonly type: 'shutdown';
}
/** DESK051-UPD, UPD-5: Settings > Updates (app-update.ts isAppUpdatePipeView). */
export interface AppUpdateMessage extends AppUpdatePipeView {
  readonly v: 1;
  readonly type: 'app-update';
}
export type ShellMessage = InviteMessage | ShowMessage | ShutdownMessage | AppUpdateMessage;

const TOKEN = '[A-Za-z0-9_-]{43}';
const PORT = '([1-9][0-9]{0,4})';
const PATH = '(/|/first-run|/settings/home|/settings/join|/settings/updates)';
const SESSION_URL = new RegExp(`^http://localhost:${PORT}${PATH}\\?t=${TOKEN}$`);

const SHORT_INVITE = /^2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const LONG_INVITE = /^[A-Za-z0-9_-]+$/;

/**
 * The origin (`http://localhost:<port>`) of a valid session link, or null. A valid link is exactly
 * `http://localhost:<port><path>?t=<43 base64url>` with the rules in the spec above.
 */
export function sessionUrlOrigin(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 300) return null;
  const match = SESSION_URL.exec(url);
  if (match === null) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65_535) return null;
  return `http://localhost:${port}`;
}

/** True for the canonical invite link `https://agentlink.4thtech.io/i#<payload>`. */
export function isCanonicalInviteLink(link: unknown): link is string {
  if (typeof link !== 'string' || !link.startsWith(INVITE_LINK_PREFIX)) return false;
  const payload = link.slice(INVITE_LINK_PREFIX.length);
  if (payload.startsWith('2.')) return SHORT_INVITE.test(payload);
  return (
    payload.length >= 1 && payload.length <= INVITE_MAX_PAYLOAD_CHARS && LONG_INVITE.test(payload)
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** True when `value` has exactly these own keys (order-insensitive). */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * Parses one line (without its "\n") as JSON, with the framing rules: no surrounding whitespace, the
 * line must be an object. Returns undefined on any problem. The size limit is the reader's job
 * (it checks bytes before decoding), but this also refuses an over-long string.
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) return undefined;
  if (!line.startsWith('{') || !line.endsWith('}')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value) || value['v'] !== PROTOCOL_VERSION) return undefined;
  return value;
}

/** A core -> shell line, strictly parsed; undefined is a protocol violation. */
export function parseCoreMessage(line: string): CoreMessage | undefined {
  const value = parseLine(line);
  if (value === undefined) return undefined;
  switch (value['type']) {
    case 'ready': {
      if (!hasExactKeys(value, ['v', 'type', 'sessionUrl'])) return undefined;
      const sessionUrl = value['sessionUrl'];
      if (typeof sessionUrl !== 'string' || sessionUrlOrigin(sessionUrl) === null) return undefined;
      return { v: 1, type: 'ready', sessionUrl };
    }
    case 'status': {
      if (!hasExactKeys(value, ['v', 'type', 'state', 'counts'])) return undefined;
      const state = value['state'];
      const counts = value['counts'];
      if (!isOneOf(HOST_STATES, state) || !isPlainObject(counts)) return undefined;
      if (!hasExactKeys(counts, ['openPages', 'waitingApprovals'])) return undefined;
      const openPages = counts['openPages'];
      const waitingApprovals = counts['waitingApprovals'];
      if (!isCount(openPages) || !isCount(waitingApprovals)) return undefined;
      return { v: 1, type: 'status', state, counts: { openPages, waitingApprovals } };
    }
    case 'approval-waiting': {
      if (!hasExactKeys(value, ['v', 'type', 'count'])) return undefined;
      const count = value['count'];
      if (!isCount(count)) return undefined;
      return { v: 1, type: 'approval-waiting', count };
    }
    case 'invite-result': {
      if (!hasExactKeys(value, ['v', 'type', 'outcome'])) return undefined;
      const outcome = value['outcome'];
      if (!isOneOf(INVITE_OUTCOMES, outcome)) return undefined;
      return { v: 1, type: 'invite-result', outcome };
    }
    case 'stopped': {
      if (!hasExactKeys(value, ['v', 'type', 'reason'])) return undefined;
      const reason = value['reason'];
      if (!isOneOf(STOP_REASONS, reason)) return undefined;
      return { v: 1, type: 'stopped', reason };
    }
    case 'app-update-check':
      if (!hasExactKeys(value, ['v', 'type'])) return undefined;
      return { v: 1, type: 'app-update-check' };
    case 'notify': {
      if (!hasExactKeys(value, ['v', 'type', 'kind', 'count', 'name'])) return undefined;
      const { kind, count, name } = value;
      if (!isOneOf(NOTIFY_KINDS, kind) || !isCount(count) || count < 1) return undefined;
      if (typeof name !== 'string') return undefined;
      if (name !== '' && (!NOTIFY_NAME_KINDS.includes(kind) || !isNotifyName(name))) {
        return undefined;
      }
      return { v: 1, type: 'notify', kind, count, name };
    }
    case 'app-update-install':
    case 'app-update-restart':
      if (!hasExactKeys(value, ['v', 'type'])) return undefined;
      return { v: 1, type: value['type'] };
    default:
      return undefined;
  }
}

/** A shell -> core line, strictly parsed; undefined is a protocol violation (WP-D3's reader). */
export function parseShellMessage(line: string): ShellMessage | undefined {
  const value = parseLine(line);
  if (value === undefined) return undefined;
  switch (value['type']) {
    case 'invite': {
      if (!hasExactKeys(value, ['v', 'type', 'link'])) return undefined;
      const link = value['link'];
      if (!isCanonicalInviteLink(link)) return undefined;
      return { v: 1, type: 'invite', link };
    }
    case 'show': {
      if (!hasExactKeys(value, ['v', 'type', 'route'])) return undefined;
      const route = value['route'];
      if (!isOneOf(SHOW_ROUTES, route)) return undefined;
      return { v: 1, type: 'show', route };
    }
    case 'shutdown':
      if (!hasExactKeys(value, ['v', 'type'])) return undefined;
      return { v: 1, type: 'shutdown' };
    case 'app-update': {
      const keys = [
        'v',
        'type',
        'state',
        'current',
        'latest',
        'download',
        'installable',
        'percent',
      ];
      if (!hasExactKeys(value, keys)) return undefined;
      const view = {
        state: value['state'],
        current: value['current'],
        latest: value['latest'],
        download: value['download'],
        installable: value['installable'],
        percent: value['percent'],
      };
      if (!isAppUpdatePipeView(view)) return undefined;
      return { v: 1, type: 'app-update', ...view };
    }
    default:
      return undefined;
  }
}

/**
 * Encodes a shell -> core message as one line (with "\n"). Re-validates through the parser, so a
 * caller cannot put an invalid value on the pipe; throws a fixed error otherwise (no value in it).
 */
export function encodeShellMessage(message: ShellMessage): string {
  let line: string;
  switch (message.type) {
    case 'invite':
      line = JSON.stringify({ v: 1, type: 'invite', link: message.link });
      break;
    case 'show':
      line = JSON.stringify({ v: 1, type: 'show', route: message.route });
      break;
    case 'shutdown':
      line = JSON.stringify({ v: 1, type: 'shutdown' });
      break;
    case 'app-update':
      line = JSON.stringify({
        v: 1,
        type: 'app-update',
        state: message.state,
        current: message.current,
        latest: message.latest,
        download: message.download,
        installable: message.installable,
        percent: message.percent,
      });
      break;
    default:
      throw new Error('protocol: unknown shell message');
  }
  if (parseShellMessage(line) === undefined) throw new Error('protocol: invalid shell message');
  return `${line}\n`;
}

/** Encodes a core -> shell message as one line (with "\n"); the mirror of encodeShellMessage. */
export function encodeCoreMessage(message: CoreMessage): string {
  let line: string;
  switch (message.type) {
    case 'ready':
      line = JSON.stringify({ v: 1, type: 'ready', sessionUrl: message.sessionUrl });
      break;
    case 'status':
      line = JSON.stringify({
        v: 1,
        type: 'status',
        state: message.state,
        counts: {
          openPages: message.counts.openPages,
          waitingApprovals: message.counts.waitingApprovals,
        },
      });
      break;
    case 'approval-waiting':
      line = JSON.stringify({ v: 1, type: 'approval-waiting', count: message.count });
      break;
    case 'invite-result':
      line = JSON.stringify({ v: 1, type: 'invite-result', outcome: message.outcome });
      break;
    case 'stopped':
      line = JSON.stringify({ v: 1, type: 'stopped', reason: message.reason });
      break;
    case 'app-update-check':
    case 'app-update-install':
    case 'app-update-restart':
      line = JSON.stringify({ v: 1, type: message.type });
      break;
    case 'notify':
      line = JSON.stringify({
        v: 1,
        type: 'notify',
        kind: message.kind,
        count: message.count,
        name: message.name,
      });
      break;
    default:
      throw new Error('protocol: unknown core message');
  }
  if (parseCoreMessage(line) === undefined) throw new Error('protocol: invalid core message');
  return `${line}\n`;
}
