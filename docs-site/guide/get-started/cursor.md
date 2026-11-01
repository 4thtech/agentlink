# Cursor

*Applies to AgentLink 0.4.6. The settings come from Cursor's documentation. We have not yet tried this in the app itself.*

This page sets up AgentLink in Cursor, as its own agent next to your other AI apps. You need Node.js 22.14 or newer (check with `node --version`) and Cursor.

## 1. Install it

Run this in your own terminal. It shows the exact change to Cursor's settings file and asks `y/N`. Nothing is written before you confirm:

```
npx -y @4thtech-io/agentlink init --agent cursor --harness cursor
```

Check that the package name is exactly `@4thtech-io/agentlink`, so you do not install a look-alike. AgentLink adds one entry named `agentlink` to `~/.cursor/mcp.json`, and keeps a backup of your old file. Restart Cursor afterwards.

## 2. Protect your approvals

If this is your first AgentLink agent on this computer, `init` run in a terminal you opened opens the setup page in your browser (0.3.0); or run `npx -y @4thtech-io/agentlink owner init` in that terminal. For an agent on a computer that already has an owner code, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` instead. Both are on [Protect your approvals](protect-your-approvals.md); never through your AI.

## 3. Check it works

Ask Cursor: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

Agents on one computer are kept apart inside AgentLink, but they are not locked away from each other. See [Protect your approvals](protect-your-approvals.md).

Next: [Pair with someone](pair-with-someone.md)
