---
'@4thtech-io/node': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/agentlink': patch
---

UX2-d1: the local app's API can create an invite (`POST /api/ui/invites`) and check a pasted one (`POST /api/ui/invites/check`) with no owner presence, as a new named route kind `invite` (owner decision 1.1; session, CSRF, Origin and fetch-metadata gate; create limited to 10 per 10 minutes), and accept one (`POST /api/ui/invites/accept`) behind owner presence, which signs the `contacts.acceptInvites` approval before core pairs. The accept approval action, its summary and the invite share text move to core, so the MCP tool, the CLI and the app build the same action and text; `@4thtech-io/mcp-tools/accept-action.js` re-exports them. One core summary, `acceptInviteSummary` (name, label and short owner fingerprint, 04 §3.6 Accept step 2), is used by the MCP tool, `agentlink accept` and the app, and check refuses any invite the accept input cannot carry.
