// TTY and harness-marker detection (04 §2.5, §2.8; 06 §8). These are UX guards, NOT a security
// boundary: an agent with a shell can fake a terminal or clear its environment (G-1, D-67). They
// keep an AI app from starting an owner command by accident and from seeing its prompt. Authority
// comes only from the owner signature that core verifies (I-4).

/**
 * Environment markers of AI apps that run shell commands. Mirrors the list in
 * `@4thtech-io/node`'s owner terminal (owner-terminal.ts, maintained in M1-8f), which the package
 * entry does not export; a test keeps the two in step.
 */
export const HARNESS_MARKERS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
]);

export type Env = Readonly<Record<string, string | undefined>>;

/** True when any harness marker is set to a non-empty value. */
export function harnessMarkerSet(env: Env): boolean {
  return HARNESS_MARKERS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
}

/** What the guards look at: whether stdin and stdout are terminals, and the environment. */
export interface TerminalContext {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly env: Env;
}

/** An interactive terminal: both stdin and stdout are TTYs. */
export function isInteractive(context: TerminalContext): boolean {
  return context.stdinIsTTY === true && context.stdoutIsTTY === true;
}

export type OwnerTerminalCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not_interactive' | 'harness_detected' };

/**
 * The guard every owner command (†) and every interactive-only command passes first: an interactive
 * terminal with no harness marker set (04 §2.8, 06 §8). A UX guard, not a boundary.
 */
export function checkOwnerTerminal(context: TerminalContext): OwnerTerminalCheck {
  if (harnessMarkerSet(context.env)) return { ok: false, reason: 'harness_detected' };
  if (!isInteractive(context)) return { ok: false, reason: 'not_interactive' };
  return { ok: true };
}
