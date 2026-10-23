# Windsurf

> **Status: Available with the next release.** The settings come from Windsurf's documentation; this has not been tried in the app yet.

**Purpose:** set up AgentLink in Windsurf, as its own agent, next to your other AI apps.

You need Node.js 22.14 or newer and Windsurf.

## 1. Create the agent for the app

Run this in your own terminal. It shows the exact change to Windsurf's settings file and asks `y/N`; nothing is written before you confirm:

```
npx -y @4thtech-io/agentlink init --agent windsurf --harness windsurf
```

Check that the package name is exactly `@4thtech-io/agentlink`, so you don't install a look-alike. AgentLink adds one entry named `agentlink` to Windsurf's settings file (`~/.config/devin/mcp_config.json`; on Windows, `AppData/Roaming/devin/mcp_config.json` in your user folder), and keeps a backup of your old file. If your Windsurf is older and keeps its settings in `~/.codeium/windsurf/mcp_config.json`, add `--config <path to the file>`. Restart Windsurf afterwards.

## 2. Protect your approvals

If this is your first AgentLink agent on this computer, run `npx -y @4thtech-io/agentlink owner init` in a terminal you opened. For an agent on a computer that already has an owner code, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` instead. Both are on [Protect your approvals](protect-your-approvals.md); never through your AI.

## 3. Check it works

Ask Windsurf: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

Agents under one computer user are kept apart inside AgentLink, not by a security boundary. See [Protect your approvals](protect-your-approvals.md).

Next: [Pair with someone](pair-with-someone.md)
