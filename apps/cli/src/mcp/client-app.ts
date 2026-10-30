// W4-LIVE-STATUS (D-143; 06 §6 "AI app id"; Q-143-4): the AI app id of an MCP client, from the
// `clientInfo.name` it sends in `initialize`, through one fixed table to an id of the 06 §7 table,
// else `other` (shown as "Another AI app"). The name is untrusted text the client chooses (I-5): it
// is compared exactly (ASCII case-folded, at most 64 characters) with the known names and is never
// stored, logged, shown or put into an error; only the id is kept. The id is a display hint, not an
// identity: any client can claim any name.
//
// | clientInfo.name         | AI app         | Source                                             |
// |-------------------------|----------------|----------------------------------------------------|
// | `claude-code`           | Claude Code    | the M1-36j table (approval-wait.ts), checked 10-22 |
// | `claude-ai`             | Claude Desktop | the name Claude Desktop sends                      |
// | `codex-mcp-client`      | Codex          | the M1-36j table                                   |
// | `gemini-cli-mcp-client` | Gemini CLI     | the M1-36j table                                   |
// | `opencode`              | OpenCode       | the name OpenCode sends                            |
// | `cursor-vscode`         | Cursor         | the name Cursor sends                              |
//
// Windsurf and Antigravity are not listed until their names are checked against the clients; until
// then they show as `other`. The table is pinned by client-app.test.ts.
import type { AiAppId } from '@4thtech-io/types';

/** The one fixed table (06 §6): a known client name to its AI app id. */
export const CLIENT_APP_IDS: Readonly<Record<string, AiAppId>> = Object.freeze({
  'claude-code': 'claude-code',
  'claude-ai': 'claude-desktop',
  'codex-mcp-client': 'codex',
  'gemini-cli-mcp-client': 'gemini-cli',
  opencode: 'opencode',
  'cursor-vscode': 'cursor',
});

/** At most this many characters are compared; a longer name is `other`. */
const MAX_NAME = 64;

/** ASCII letters only are folded (no locale rules). */
const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The AI app id for a client name: an exact own key of the table after ASCII folding, else `other`. */
export function mcpAppIdFor(clientName: unknown): AiAppId | 'other' {
  if (typeof clientName !== 'string' || clientName.length === 0 || clientName.length > MAX_NAME) {
    return 'other';
  }
  const key = asciiLower(clientName);
  const id = Object.hasOwn(CLIENT_APP_IDS, key) ? CLIENT_APP_IDS[key] : undefined;
  return id ?? 'other';
}
