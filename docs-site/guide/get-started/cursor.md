# Cursor

> **Status: Available with the next release.** The settings come from Cursor's documentation; this has not been tried in the app yet.

**Purpose:** set up AgentLink in Cursor, as its own agent, next to your other AI apps.

You need Node.js 22.14 or newer and Cursor.

## 1. Create the agent for the app

Run this in your own terminal. It shows the exact change to Cursor's settings file and asks `y/N`; nothing is written before you confirm:

```
npx -y @4thtech-io/agentlink init --agent cursor --harness cursor
```

Check that the package name is exactly `@4thtech-io/agentlink`, so you don't install a look-alike. AgentLink adds one entry named `agentlink` to `~/.cursor/mcp.json`, and keeps a backup of your old file. Restart Cursor afterwards.

## 2. Protect your approvals

If this is your first AgentLink agent on this computer, run `npx -y @4thtech-io/agentlink owner init` in a terminal you opened. For an agent on a computer that already has an owner code, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` instead. Both are on [Protect your approvals](protect-your-approvals.md); never through your AI.

## 3. Check it works

Ask Cursor: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

Agents under one computer user are kept apart inside AgentLink, not by a security boundary. See [Protect your approvals](protect-your-approvals.md).

Next: [Pair with someone](pair-with-someone.md)
