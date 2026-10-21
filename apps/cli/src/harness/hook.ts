// The optional SessionStart hook for Claude Code (M1-29; 06 §7, D-53): at the start of a session it
// runs `agentlink status --brief`, whose output Claude Code adds to the session. It is a separate
// opt-in from the MCP entry (`init --hook`), with the same exact-diff-and-confirm step, and never
// installed silently. The edit is exact and additive like the MCP entry's (json-config.ts): the
// file must be what `JSON.stringify` would print for its own contents, the hook is added as the
// first item so no existing line changes, and anything else is refused, never rewritten.
//
// Codex and Gemini CLI are not written here: their hook support is not verified for this release
// (the docs say so). The command is always an absolute, installed program (installed-cli.ts).
import { unifiedDiff } from './diff.js';
import { HarnessError, type HarnessErrorCode } from './errors.js';
import { readConfigFile, writeConfigFile, type ConfigFile } from './files.js';
import { HARNESSES, type HarnessContext, type HarnessDef } from './harnesses.js';
import { canonicalForm, isPlain, type JsonEdit, type Plain } from './json-config.js';

/** Claude Code's user settings file, below the home folder. */
export const HOOK_SETTINGS_PARTS: readonly string[] = Object.freeze(['.claude', 'settings.json']);
export const HOOK_SETTINGS_DISPLAY = '~/.claude/settings.json';

/** The hook's seconds budget: above the 3 s catch-up of `status --brief` (06 §2.0), below a stall. */
const HOOK_TIMEOUT_SECONDS = 5;

export function sessionHookEntry(command: string): Plain {
  return {
    matcher: 'startup|resume',
    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

/** The commands of every hook in a SessionStart list (a malformed shape is skipped, not trusted). */
function commandsOf(list: readonly unknown[]): string[] {
  const found: string[] = [];
  for (const group of list) {
    if (!isPlain(group) || !Array.isArray(group['hooks'])) continue;
    for (const hook of group['hooks'] as unknown[]) {
      if (isPlain(hook) && typeof hook['command'] === 'string') found.push(hook['command']);
    }
  }
  return found;
}

/** The new text of a settings file with the AgentLink SessionStart hook added. */
export function addJsonSessionHook(text: string | undefined, command: string): JsonEdit {
  const entry = sessionHookEntry(command);
  if (text === undefined) {
    return {
      status: 'change',
      text: `${JSON.stringify({ hooks: { SessionStart: [entry] } }, null, 2)}\n`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError('malformed');
  }
  if (!isPlain(parsed)) throw new HarnessError('malformed');
  const form = canonicalForm(text, parsed);
  if (form === undefined) throw new HarnessError('unsupported_format');

  const hooks = parsed['hooks'];
  let nextHooks: Plain;
  if (hooks === undefined) {
    nextHooks = { SessionStart: [entry] };
  } else {
    if (!isPlain(hooks)) throw new HarnessError('unsupported_format');
    const list = hooks['SessionStart'];
    if (list === undefined) {
      nextHooks = Object.fromEntries([['SessionStart', [entry]], ...Object.entries(hooks)]);
    } else {
      if (!Array.isArray(list)) throw new HarnessError('unsupported_format');
      const existing = commandsOf(list);
      if (existing.includes(command)) return { status: 'present' };
      // Another AgentLink status hook (an older path, say) is the user's: left alone.
      if (existing.some((c) => c.includes('agentlink') && c.includes('status --brief'))) {
        return { status: 'conflict' };
      }
      nextHooks = Object.fromEntries(
        Object.entries(hooks).map(([name, value]) => [
          name,
          name === 'SessionStart' ? [entry, ...(list as Plain[])] : value,
        ]),
      );
    }
  }
  const next =
    hooks === undefined
      ? Object.fromEntries([['hooks', nextHooks], ...Object.entries(parsed)])
      : Object.fromEntries(
          Object.entries(parsed).map(([name, value]) => [
            name,
            name === 'hooks' ? nextHooks : value,
          ]),
        );
  return {
    status: 'change',
    text: `${JSON.stringify(next, null, form.indent)}${form.newline ? '\n' : ''}`,
  };
}

export type HookPlan =
  | {
      readonly status: 'change';
      readonly before: ConfigFile;
      readonly text: string;
      readonly diff: readonly string[];
    }
  | { readonly status: 'present' }
  | { readonly status: 'conflict' }
  | { readonly status: 'blocked'; readonly reason: HarnessErrorCode };

/** The only harness with a verified SessionStart hook in this release. */
export const HOOK_HARNESS: HarnessDef = (() => {
  const def = HARNESSES.find((h) => h.id === 'claude-code');
  if (def === undefined) throw new Error('claude-code harness missing');
  return def;
})();

/** Reads Claude Code's settings and works out the exact change, without writing anything. */
export async function planSessionHook(context: HarnessContext, command: string): Promise<HookPlan> {
  // CLAUDE_CONFIG_DIR moves Claude Code's files: not followed, so the hook is refused (as for MCP).
  if ((context.env['CLAUDE_CONFIG_DIR'] ?? '') !== '') {
    return { status: 'blocked', reason: 'unsupported_format' };
  }
  try {
    const before = await readConfigFile(context.home, HOOK_SETTINGS_PARTS, context);
    const edit = addJsonSessionHook(before.text, command);
    if (edit.status === 'present') return { status: 'present' };
    if (edit.status === 'conflict') return { status: 'conflict' };
    return {
      status: 'change',
      before,
      text: edit.text,
      diff: unifiedDiff(before.text ?? '', edit.text, HOOK_SETTINGS_DISPLAY),
    };
  } catch (error) {
    if (error instanceof HarnessError) return { status: 'blocked', reason: error.code };
    throw error;
  }
}

/** Writes a planned change (atomic, with a backup). Returns the backup's file name, if any. */
export function applySessionHook(
  plan: Extract<HookPlan, { status: 'change' }>,
  context: HarnessContext,
): Promise<{ backup: string | undefined }> {
  return writeConfigFile(context.home, HOOK_SETTINGS_PARTS, plan.before, plan.text, context);
}
