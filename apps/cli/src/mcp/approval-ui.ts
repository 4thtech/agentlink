// M1-11a-b: the local approval UI inside `agentlink mcp` (08 §1; 06 §2.5; 04 §2.5; I-4, I-5, I-7).
//
// - On demand: the local approval server (@4thtech-io/node, M1-8d/M1-11a) starts on the first
//   `pending_approval` and is reused for the life of the MCP server; `close()` stops it before the
//   agent closes. A server that cannot start leaves the M1a result (the `agentlink approve` command
//   only) and is tried again on the next request.
// - The link in the result is `http://localhost:<port>/approve/<approvalId>` and nothing else: the
//   origin must be exactly `http://localhost:<port>` and the url exactly that path, with no query.
//   The agent sees it, so it holds no secret. It grants nothing on its own: the page and the API need
//   the session cookie, which only the one-shot session link gives, and that link goes only to the
//   OS browser opener (`server.open`), never into a result, a log line or an error. A decision needs
//   owner presence (the owner code or the localhost passkey) on top of the session (08 §1).
// - The owner is alerted at most once per BROWSER_OPEN_INTERVAL_MS across all requests (IR-M1-11a-b-1
//   L-3): the browser opens with the one-shot link, or, when no browser could be opened, the fixed OS
//   notification is raised (08 §1: "Opens automatically (or via OS notification)"). Requests inside
//   the interval are coalesced: the page the owner already has lists every pending request, so an
//   agent that keeps raising requests cannot flood the screen.
// - No browser, no link (IR-M1-11a-b-1 L-2): when the opener cannot run (its program is missing at
//   its absolute path, or fails), the session link never reached a browser, so the url would only
//   show the expired page. The result then stays CLI-only, now and for the rest of the session.
// - The nextStep keeps the `agentlink approve` command (06 §2.5 step 2) for an owner whose browser
//   has no session (another browser, or a stale link), and tells the agent never to open or fetch
//   the link itself.
//
// Accepted (G-1, D-67; 04 §2.5): a same-user process can read the opener's argv for the one-shot
// link and get a view-only session; it still cannot approve without owner presence.
import type { Logger } from '@4thtech-io/log';
import type { ApprovalServer } from '@4thtech-io/node';
import { approveCommand, isApprovalId } from '../approval/next-step.js';
import type { ApprovalLink } from '../tools/index.js';

/** The shortest time between two browser windows the server opens by itself. */
export const BROWSER_OPEN_INTERVAL_MS = 30_000;
/** Requests remembered as already announced (opened or notified); the oldest is forgotten. */
const MAX_ANNOUNCED = 256;
/** The local UI origin (08 §1, D-79): `http://localhost:<port>`, nothing else. */
const UI_ORIGIN = /^http:\/\/localhost:([1-9][0-9]{0,4})$/;

const NEVER_FETCH = 'Never open or fetch this link yourself. ';
const LEAD = 'Tell the user: Approval needed. Approve here: ';
const OR_CLI = ' or in your own terminal run ';
const ADD_AGENT = " If you have more than one agent, add --agent with this agent's name.";
const TAIL =
  " Your AI can't approve this for you. After they approve, call the same tool again with approvalId.";

/**
 * The nextStep of a `pending_approval` with the local UI link. Both inserted values are checked by
 * the caller (the ID by approveCommand, the url by createApprovalUi); the agent name is inserted
 * only after approveCommand checks it again (06 §2.5 step 2).
 */
export function approvalLinkNextStep(approvalId: string, url: string, agentName?: string): string {
  const { command, needsAgentHint } = approveCommand(approvalId, agentName);
  return `${NEVER_FETCH}${LEAD}${url}${OR_CLI}\`${command}\`.${needsAgentHint ? ADD_AGENT : ''}${TAIL}`;
}

export interface ApprovalUi {
  /** The link for one request; starts the server on first use. Undefined: no link (M1a result). */
  link(approvalId: string): Promise<ApprovalLink | undefined>;
  /** True while a server is running. */
  readonly running: boolean;
  /** Stops the server (if one started) and gives no link afterwards. Idempotent. */
  close(): Promise<void>;
}

export interface ApprovalUiOptions {
  /** Starts the local approval server for this agent. */
  readonly start: () => Promise<ApprovalServer>;
  /** The local agent name this MCP server serves (for the `--agent` of the CLI command). */
  readonly agentName: string;
  readonly logger: Logger;
  /** Milliseconds. Default Date.now. */
  readonly nowMs?: () => number;
}

/** The link for `approvalId` on `server`, or undefined when anything is off (fail closed). */
function linkOn(
  server: ApprovalServer,
  approvalId: string,
  agentName: string,
): ApprovalLink | undefined {
  const origin = server.origin;
  const port = typeof origin === 'string' ? UI_ORIGIN.exec(origin)?.[1] : undefined;
  if (port === undefined || Number(port) > 65_535) return undefined;
  const url = server.approvalUrl(approvalId);
  if (url !== `${origin}/approve/${approvalId}`) return undefined;
  return Object.freeze({
    url,
    origin,
    nextStep: approvalLinkNextStep(approvalId, url, agentName),
  });
}

export function createApprovalUi(options: ApprovalUiOptions): ApprovalUi {
  const { start, agentName, logger } = options;
  const now = options.nowMs ?? Date.now;
  let starting: Promise<ApprovalServer | undefined> | undefined;
  let server: ApprovalServer | undefined;
  let closed = false;
  let lastAlertAt = Number.NEGATIVE_INFINITY;
  /** The latest browser open, and whether any open ever succeeded or failed. */
  let lastOpen: Promise<boolean> | undefined;
  let browserOpened = false;
  let openerFailed = false;
  const announced = new Set<string>();

  const ensure = (): Promise<ApprovalServer | undefined> => {
    starting ??= start().then(
      async (started) => {
        if (closed) {
          await started.close().catch(() => undefined);
          return undefined;
        }
        server = started;
        logger.info('approval ui started');
        return started;
      },
      () => {
        // The error could carry a value (I-7): only a fixed line. The next request tries again.
        logger.warn('approval ui unavailable');
        starting = undefined;
        return undefined;
      },
    );
    return starting;
  };

  /**
   * Alerts the owner for a new request (at most once per interval overall) and resolves whether the
   * owner's browser holds a session for the link (a browser was opened at least once).
   */
  const announce = async (running: ApprovalServer, approvalId: string): Promise<boolean> => {
    if (!announced.has(approvalId)) {
      announced.add(approvalId);
      if (announced.size > MAX_ANNOUNCED) {
        const oldest = announced.values().next().value;
        if (oldest !== undefined) announced.delete(oldest);
      }
      const at = now();
      if (at - lastAlertAt >= BROWSER_OPEN_INTERVAL_MS) {
        lastAlertAt = at;
        if (openerFailed) {
          running.notifyNewApproval(approvalId).catch(() => undefined);
        } else {
          lastOpen = running.open(approvalId).then(
            (opened) => {
              if (opened) browserOpened = true;
              else {
                openerFailed = true;
                logger.warn('approval ui: no browser could be opened');
                running.notifyNewApproval(approvalId).catch(() => undefined);
              }
              return opened;
            },
            () => false,
          );
        }
      }
    }
    if (browserOpened) return true;
    if (openerFailed || lastOpen === undefined) return false;
    return (await lastOpen) || browserOpened;
  };

  return Object.freeze<ApprovalUi>({
    link: async (approvalId: string) => {
      if (closed || !isApprovalId(approvalId)) return undefined;
      const running = await ensure();
      if (running === undefined || closed) return undefined;
      let link: ApprovalLink | undefined;
      try {
        link = linkOn(running, approvalId, agentName);
      } catch {
        return undefined;
      }
      if (link === undefined) return undefined;
      return (await announce(running, approvalId)) && !closed ? link : undefined;
    },
    get running() {
      return server !== undefined && !closed;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const pending = starting;
      const running = server ?? (pending === undefined ? undefined : await pending);
      server = undefined;
      if (running !== undefined) {
        await running.close().catch(() => undefined);
        logger.info('approval ui stopped');
      }
    },
  });
}
