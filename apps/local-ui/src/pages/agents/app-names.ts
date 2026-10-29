// U3-i: GET /api/ui/agents holds each agent's AI apps as app IDS ("claude-code", U3-f); the switcher,
// the Agents page and Start here show NAMES ("Claude Code"). The names come from GET /api/ui/apps
// (the fixed names of the harness table); this fixed table is only the fallback when that read
// fails. An id neither knows stays as it is (it is a short word of the fixed table, never file text).

const FIXED: Readonly<Record<string, string>> = Object.freeze({
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
});

const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The id to name pairs of a GET /api/ui/apps answer (anything malformed is skipped). */
export function parseAppNames(value: unknown): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const apps = (value as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return names;
  for (const a of apps) {
    const { app, name } = (a ?? {}) as { app?: unknown; name?: unknown };
    if (typeof app === 'string' && ID.test(app) && typeof name === 'string' && name !== '') {
      names.set(app, name.slice(0, 40));
    }
  }
  return names;
}

/** The name to show for an app id: the server's, else the fixed one, else the id itself. */
export function appNameOf(id: string, fetched?: ReadonlyMap<string, string>): string {
  return fetched?.get(id) ?? FIXED[id] ?? id;
}
