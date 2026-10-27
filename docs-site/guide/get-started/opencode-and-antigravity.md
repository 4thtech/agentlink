# OpenCode and Antigravity

*Applies to AgentLink 0.4.0. The settings come from each app's documentation. We have not yet tried Antigravity in the app itself.*

This page sets up AgentLink in OpenCode or Antigravity. Each gets its own agent, next to your other AI apps. You need Node.js 22.14 or newer (check with `node --version`) and the AI app.

## 1. Install it

Run the line for your app in your own terminal. It shows the exact change to the app's settings file and asks `y/N`. Nothing is written before you confirm:

```
npx -y @4thtech-io/agentlink init --agent opencode --harness opencode
npx -y @4thtech-io/agentlink init --agent antigravity --harness antigravity
```

Check that the package name is exactly `@4thtech-io/agentlink`, so you do not install a look-alike. If your Antigravity keeps its settings elsewhere, add `--config <path to the file>`. Restart the app afterwards.

## 2. Protect your approvals

If this is your first AgentLink agent on this computer, `init` run in a terminal you opened opens the setup page in your browser (0.3.0); or run `npx -y @4thtech-io/agentlink owner init` in that terminal. For an agent on a computer that already has an owner code, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` instead. Both are on [Protect your approvals](protect-your-approvals.md); never through your AI.

## 3. Check it works

Ask the app: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

Agents on one computer are kept apart inside AgentLink, but they are not locked away from each other. See [Protect your approvals](protect-your-approvals.md). The exact settings written are in [Harness configuration](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md).

Next: [Pair with someone](pair-with-someone.md)
