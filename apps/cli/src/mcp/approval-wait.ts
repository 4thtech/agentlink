// M1-36j (D4): how long a tool call may wait for the owner's decision while the approval page is
// open, per harness. The harness is the MCP client's `clientInfo.name` from `initialize`; an exact,
// own-key match only. Unknown, missing or odd names get no wait (0), so a harness whose tool-call
// timeout we have not checked never sees a call that runs longer than before.
//
// The rule: at most APPROVAL_WAIT_MAX_MS (D4: "about 45 s"), and at most half of the harness's
// default tool-call timeout, so the result always arrives well before the harness gives up.
// MCP progress notifications are not used: none of the checked harnesses resets its timeout on
// progress (research in the M1-36j PR, checked 2026-10-22).
//
// | clientInfo.name         | Harness     | Default tool-call timeout                      | Wait  |
// |-------------------------|-------------|------------------------------------------------|-------|
// | `claude-code`           | Claude Code | about 28 h unless MCP_TOOL_TIMEOUT is set       | 45 s  |
// | `gemini-cli-mcp-client` | Gemini CLI  | 10 min (per-server `timeout`)                   | 45 s  |
// | `codex-mcp-client`      | Codex       | 60 s (`tool_timeout_sec`)                       | 30 s  |
// | anything else           | Claude Desktop, Cursor, Windsurf, OpenCode, Antigravity, others: timeout unknown or about 60 s with no setting | 0 |
//
// Configurable per harness: change the table (or pass another lookup to createMcpServer).
// M1-36i-e: the value is the whole call's budget for waiting: time the tool already spent (a free
// test credits wait) comes off it (tools/approval-wait.ts `approvalWaitLeft`), never added to it.

/** The longest wait for any harness (D4). */
export const APPROVAL_WAIT_MAX_MS = 45_000;

/** The wait per MCP `clientInfo.name`, in ms. */
export const APPROVAL_WAIT_MS_BY_CLIENT: Readonly<Record<string, number>> = Object.freeze({
  'claude-code': 45_000,
  'gemini-cli-mcp-client': 45_000,
  'codex-mcp-client': 30_000,
});

/** The wait for this client name: the table's value for an exact own key, else 0. */
export function approvalWaitMsFor(clientName: unknown): number {
  if (typeof clientName !== 'string' || !Object.hasOwn(APPROVAL_WAIT_MS_BY_CLIENT, clientName)) {
    return 0;
  }
  const ms = APPROVAL_WAIT_MS_BY_CLIENT[clientName];
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? Math.min(ms, APPROVAL_WAIT_MAX_MS)
    : 0;
}
