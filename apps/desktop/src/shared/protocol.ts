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
// - Never on the pipe: keys, seeds, owner codes, passphrases, message text, contact names, file names.
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
//
// Shell -> core
//   {"v":1,"type":"invite","link":"https://agentlink.4thtech.io/i#<payload>"}
//       An invite from an agentlink:// link, already rebuilt to the canonical link (WP-D9). <payload>
//       is the short form "2." + 43 base64url characters (last one with zero trailing bits) or the
//       long form of 1..21846 base64url characters (packages/core invite-link.ts). The core keeps it
//       in memory as the waiting invite and answers with a "ready" for the join page.
//   {"v":1,"type":"show","route":<SHOW_ROUTES>}
//       The person asked for a page (tray, dock, second launch). The core answers with a "ready"
//       carrying a fresh session link for that route's fixed path.
//   {"v":1,"type":"shutdown"}
//       Close cleanly (close the agent, the server and the relays) and exit 0. The shell kills the
//       core if it has not exited within its grace period.
// ------------------------------------------------------------------------------------------------
//
// This module is pure (no Node or Electron APIs) so both sides and their tests can use it.

/** Protocol version carried in every message as `"v": 1`. */
export const PROTOCOL_VERSION = 1;

/** Longest line in bytes, newline excluded (a long-form invite is about 21.9k characters). */
export const MAX_LINE_BYTES = 32 * 1024;

/** Largest count a status or approval-waiting message may carry. */
export const MAX_COUNT = 1_000_000;

/** The session link paths the core may send (approval-server.ts open*, invite-paths.ts). */
export const SESSION_PATHS = ['/', '/first-run', '/settings/home', '/settings/join'] as const;

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

/** The pages the shell may ask the core to open; the core maps each to a fixed path. */
export const SHOW_ROUTES = ['home', 'approvals', 'join'] as const;
export type ShowRoute = (typeof SHOW_ROUTES)[number];

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
export type CoreMessage =
  ReadyMessage | StatusMessage | ApprovalWaitingMessage | InviteResultMessage | StoppedMessage;

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
export type ShellMessage = InviteMessage | ShowMessage | ShutdownMessage;

const TOKEN = '[A-Za-z0-9_-]{43}';
const PORT = '([1-9][0-9]{0,4})';
const PATH = '(/|/first-run|/settings/home|/settings/join)';
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
    default:
      throw new Error('protocol: unknown core message');
  }
  if (parseCoreMessage(line) === undefined) throw new Error('protocol: invalid core message');
  return `${line}\n`;
}
