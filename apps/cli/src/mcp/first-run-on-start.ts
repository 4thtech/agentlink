// M1-11b-8: `agentlink mcp` opens the first-run page once per start while there is no owner
// (06 §7; D-120 (1); D-130 (1); IR-M1-11b-6-1 recommendation (c)).
//
// - Install, then the AI app (re)starts its AgentLink server, and the setup page opens in the
//   owner's browser, where one passkey gesture sets up the owner (D-130 (1)).
// - Once per process start, only while owner setup is wired (a keychain agent, no owner anywhere,
//   the app in this build; local-ui-wiring.ts), and only on a machine with a display: never in CI,
//   over SSH, or on Linux without DISPLAY or WAYLAND_DISPLAY. Nothing is retried.
// - The one-shot link goes only to the OS opener, through the approval UI's `openSetupPage`
//   (approval-ui.ts). It is never in a tool result, a log line or MCP output; this step answers a
//   boolean and logs fixed lines only. No tool calls it (first-run.test.ts fence): it runs from
//   command.ts after the MCP connection is up.
// - Tools are unchanged: `needs_setup` with the fixed command when the agent is not set up, and the
//   owner-setup text (`init`, `owner init`, named with `cliPrefix()`) as the fallback.
//
// Threat note (G-1, D-67; 04 §2.5): an agent with a shell can start `agentlink mcp` itself and so
// cause the page to open; it never gets the link (argv exposure is the accepted G-1 residual of
// the opener). Setting up the owner still needs the human's passkey gesture on the page, and the
// server re-checks that no owner exists on every begin and finish (M1-11s-c `setupGate`). This step
// adds no route and no authority.
import type { Logger } from '@4thtech-io/log';
import type { ApprovalUi } from './approval-ui.js';

/** The environment variables the display check reads (process.env in production). */
export type DisplayEnv = Readonly<Record<string, string | undefined>>;

function set(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/**
 * True when no browser should be opened here: CI (a `CI` value other than empty, `0` or `false`),
 * an SSH session, or a platform other than macOS and Windows without an X11 or Wayland display.
 */
export function headlessDisplay(env: DisplayEnv, platform: string): boolean {
  const ci = env['CI'];
  if (set(ci) && ci !== '0' && ci?.toLowerCase() !== 'false') return true;
  if (set(env['SSH_CONNECTION']) || set(env['SSH_TTY']) || set(env['SSH_CLIENT'])) return true;
  if (platform === 'darwin' || platform === 'win32') return false;
  return !set(env['DISPLAY']) && !set(env['WAYLAND_DISPLAY']);
}

export interface FirstRunOnStartOptions {
  /** True only while owner setup may be wired for this agent (fail closed). */
  readonly available: () => Promise<boolean>;
  readonly ui: Pick<ApprovalUi, 'openSetupPage'>;
  readonly logger?: Logger;
  readonly env: DisplayEnv;
  readonly platform: string;
}

/** Opens the first-run page when it may be (see the header). Resolves whether it opened; never throws. */
export async function openFirstRunOnStart(options: FirstRunOnStartOptions): Promise<boolean> {
  const { logger } = options;
  try {
    if (headlessDisplay(options.env, options.platform)) return false;
    if ((await options.available()) !== true) return false;
    const opened = await options.ui.openSetupPage();
    // Fixed lines only (I-7): never the link, a token or the server's address.
    if (opened) logger?.info('first-run page opened');
    else logger?.debug('first-run page not opened');
    return opened;
  } catch {
    logger?.debug('first-run page not opened');
    return false;
  }
}
