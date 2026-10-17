# OpenCode and Antigravity

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** The OpenCode and Antigravity settings come from each app's documentation; Antigravity is not yet tried in the app.

**Purpose:** set up AgentLink in OpenCode or Antigravity, each as its own agent, next to your other AI apps.

You need Node.js 22.14 or newer and the AI app.

## 1. Create the agent for the app

Run this in your own terminal. It shows the exact change to the app's settings file and asks `y/N`; nothing is written before you confirm:

```
npx -y @4thtech-io/agentlink init --agent opencode --harness opencode
npx -y @4thtech-io/agentlink init --agent antigravity --harness antigravity
```

Check that the package name is exactly `@4thtech-io/agentlink`, so you don't install a look-alike. If your Antigravity build keeps its settings elsewhere, add `--config <path to the file>`. Restart the app afterwards.

## 2. Protect your approvals

If this is your first AgentLink agent on this computer, run `npx -y @4thtech-io/agentlink owner init` in a terminal you opened. For an agent on a computer that already has an owner code, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` instead. Both are on [Protect your approvals](protect-your-approvals.md); never through your AI.

## 3. Check it works

Ask the app: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

Agents under one computer user are kept apart inside AgentLink, not by a security boundary. See [Protect your approvals](protect-your-approvals.md). The exact settings written are in [Harness configuration](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md).

Next: [Pair with someone](pair-with-someone.md)
