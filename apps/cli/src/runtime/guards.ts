// TTY and harness-marker detection (04 §2.5, §2.8; 06 §8). These are UX guards, NOT a security
// boundary: an agent with a shell can fake a terminal or clear its environment (G-1, D-67). They
// keep an AI app from starting an owner command by accident and from seeing its prompt. Authority
// comes only from the owner signature that core verifies (I-4).
import type { HarnessId } from '../harness/harnesses.js';

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
  'CODEX_THREAD_ID',
  'GEMINI_CLI',
  'OPENCODE',
  'OPENCODE_CLIENT',
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'ANTIGRAVITY_AGENT',
  'AI_AGENT',
]);

/**
 * R1-SEC-14 (04 §2.8 "known harness markers", maintained): where each marker comes from, one entry
 * per AI app `init` supports (harness/harnesses.ts HARNESS_IDS; a test fails for an app with no
 * entry). An app with no app-specific marker says so; the TTY guard and owner presence still apply.
 * `CURSOR_TRACE_ID` is set in every Cursor terminal, so the owner step is refused there too: Cursor's
 * AI can read that terminal, and the owner code must never be shown to it. `AI_AGENT` is the shared
 * convention some AI apps set for the commands they run.
 */
export const HARNESS_MARKERS_BY_APP: Readonly<
  Record<HarnessId, { readonly markers: readonly string[]; readonly note?: string }>
> = Object.freeze({
  'claude-code': { markers: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT'] },
  'claude-desktop': {
    markers: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT'],
    note: 'Its built-in Claude Code sets the Claude Code markers; the chat runs no shell of its own.',
  },
  codex: { markers: ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'] },
  'gemini-cli': { markers: ['GEMINI_CLI'] },
  opencode: { markers: ['OPENCODE', 'OPENCODE_CLIENT'] },
  cursor: { markers: ['CURSOR_AGENT', 'CURSOR_TRACE_ID'] },
  antigravity: { markers: ['ANTIGRAVITY_AGENT', 'AI_AGENT'] },
  windsurf: {
    markers: ['AI_AGENT'],
    note: 'No app-specific marker is known; the shared AI_AGENT convention only.',
  },
});

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
