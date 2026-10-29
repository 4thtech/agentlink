// `agentlink join '<inviteUrl>'` (U3-invite; 06 §8, 08 §4 "One step from an invite link"; 04 §3.6;
// I-2, I-4, I-5, I-7): the invite page's one command. It checks the invite and opens the local app
// with it waiting; the accept happens in the app with the owner's Touch ID.
//
// 1. Exactly one argument and no option (the dispatcher hands the raw arguments here). One
//    surrounding pair of `'` is removed (cmd.exe passes them through) and nothing else. Then the
//    08 §4 pattern with the shipped host (core INVITE_LINK_PREFIX), then core's Accept step 1
//    (checkInviteLink: the D-69 decoder, schema, expiry, both card signatures, nameHash, the relay
//    URL rule) before anything else happens. Anything else gets one fixed line and exit code 2.
//    No part of the argument is ever printed, logged or put into an error.
// 2. An app host already running (its 0600 `app-host.json`, its pid alive): one loopback handoff
//    (runtime/app-host-record.ts). `invite_waiting` prints the fixed "finish or close" line.
// 3. Otherwise, in the owner's own terminal: the app starts exactly as `agentlink ui` does, with the
//    invite held in memory by the host, and the browser opens on first run (no owner yet) or the
//    join screen. Run by an AI (no TTY or a harness marker), where no running host can take it: the
//    fixed line telling the person to run the command from the invite page in their own terminal
//    (M1-UX-OPEN-APP, the AI-opened app, is a later card).
//
// `join` never reads the clipboard or standard input, never fetches anything (its only request is
// the loopback handoff), never accepts, signs, prints or stores the invite, and never writes an AI
// app config.
//
// Threat note (G-1, D-67; 04 §2.5): the TTY and marker checks are UX guards. A same-user process
// that reads the record can only set a waiting invite, which still needs the owner's presence to
// accept; the page shows who it is first. Residuals (08 §4): the shell history, the process list and
// npm's debug log can hold the command line, so the link reaches the disk outside `join`'s control.
import {
  INVITE_LINK_PREFIX,
  INVITE_MAX_PAYLOAD_CHARS,
  CoreError,
  checkInviteLink,
} from '@4thtech-io/core';
import { homedir } from 'node:os';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandHandler,
} from '../dispatch.js';
import {
  pidAlive,
  readAppHostRecord,
  sendHandoff,
  type AppHostRecord,
  type HandoffOutcome,
} from '../runtime/app-host-record.js';
import { checkOwnerTerminal } from '../runtime/guards.js';
import { cliPrefix } from '../runtime/cli-prefix.js';
import { nodeUiDeps, serveUi, type UiDeps } from './ui.js';

/** Fixed text (11 §5; b11 §33.3). Nothing from the argument is ever inserted. */
export const JOIN_TEXT = Object.freeze({
  refused: "This isn't a complete AgentLink invite. Open the link again and copy the command.",
  expired: 'This invite has expired. Ask the person who sent it for a new one.',
  waiting: 'Finish or close the invite already open in AgentLink, then run the command again.',
  handedOff: 'AgentLink opened the invite in your browser. Check who it is, then accept it there.',
  opened:
    "Your browser opened AgentLink with the invite. Set it up there, then accept the invite. Keep this window open while you use it; press Ctrl+C when you're done.",
  agentRun:
    "You must do this yourself: run the command from the invite page in your own terminal. It opens AgentLink in your browser so you can accept the invite there. Don't let your AI accept it for you.",
});

/** 08 §4: the shipped host's prefix and 1 to 21 846 base64url characters, nothing else. */
const CANONICAL = new RegExp(
  `^${INVITE_LINK_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[A-Za-z0-9_-]{1,${String(INVITE_MAX_PAYLOAD_CHARS)}}$`,
);

/**
 * The canonical link from the raw arguments, or undefined. Exactly one argument; one surrounding
 * pair of `'` removed (cmd.exe and some shells pass the quotes through); nothing else trimmed.
 */
export function joinLinkOf(args: readonly string[]): string | undefined {
  if (args.length !== 1) return undefined;
  let value = args[0] as string;
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  return CANONICAL.test(value) ? value : undefined;
}

export interface JoinDeps {
  /** Accept step 1 (core checkInviteLink). */
  check(link: string, nowSeconds: number): Promise<unknown>;
  /** Unix seconds. */
  now(): number;
  /** The running app host's handoff record, if one is there. */
  readRecord(): Promise<AppHostRecord | undefined>;
  alive(pid: number): boolean;
  handoff(record: AppHostRecord, link: string): Promise<HandoffOutcome>;
  /** The `ui` steps (start with the waiting invite, serve until Ctrl+C). */
  readonly ui: UiDeps;
}

/** The command. Returns the process exit code. */
export async function joinStep(
  context: CommandContext,
  deps: JoinDeps = nodeJoinDeps(),
  prefix: string = cliPrefix(),
): Promise<number> {
  const { output } = context;
  const link = joinLinkOf(context.parsed.positionals);
  if (link === undefined) {
    output.printError(JOIN_TEXT.refused);
    return EXIT_USAGE;
  }
  try {
    await deps.check(link, deps.now());
  } catch (error) {
    output.printError(
      error instanceof CoreError && error.code === 'invite_expired'
        ? JOIN_TEXT.expired
        : JOIN_TEXT.refused,
    );
    return EXIT_USAGE;
  }
  // An app host already running takes it with one loopback request.
  const record = await deps.readRecord().catch(() => undefined);
  if (record !== undefined && deps.alive(record.pid)) {
    const outcome = await deps.handoff(record, link).catch((): HandoffOutcome => 'failed');
    if (outcome === 'waiting') {
      output.print(JOIN_TEXT.handedOff);
      return EXIT_OK;
    }
    if (outcome === 'invite_waiting') {
      output.printError(JOIN_TEXT.waiting);
      return EXIT_FAILED;
    }
    // A stale record or a refused handoff: start our own host below.
  }
  if (!checkOwnerTerminal(context.terminal).ok) {
    output.printError(JOIN_TEXT.agentRun);
    return EXIT_FAILED;
  }
  return serveUi(context, deps.ui, prefix, { invite: link, opened: JOIN_TEXT.opened });
}

/** The production deps: core's check, the record under the OS user's home, the `ui` deps. */
export function nodeJoinDeps(): JoinDeps {
  const home = homedir();
  return Object.freeze<JoinDeps>({
    check: (link, nowSeconds) => checkInviteLink(link, nowSeconds),
    now: () => Math.floor(Date.now() / 1000),
    readRecord: () => readAppHostRecord(home),
    alive: pidAlive,
    handoff: (record, link) => sendHandoff(record, link),
    ui: nodeUiDeps(),
  });
}

/** The registered handler. */
export const joinHandler: CommandHandler = (context) => joinStep(context);
