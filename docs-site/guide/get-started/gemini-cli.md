# Gemini CLI

> **Status: Planned for v0.1.0 (M1a).** Nothing is released yet, so the install below does not work until v0.1.0 ships. The steps match the current source.

**Purpose:** set up AgentLink in Gemini CLI.

You need Node.js (a current LTS version) and Gemini CLI.

## 1. Ask Gemini to install it

Paste this into Gemini CLI:

> Install AgentLink for me. Run `npx -y @4thtech/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart Gemini CLI when it's done.

What happens:

1. Gemini runs `npx -y @4thtech/agentlink init`. It looks for Claude Code, Codex and Gemini CLI on your computer, prints the exact change to each settings file and a short confirmation code, and writes nothing yet.
2. Gemini shows you the change. For Gemini CLI it adds one entry named `agentlink` to `~/.gemini/settings.json`. Check that it is the only change.
3. If you agree, Gemini runs the command again with `--confirm <code>`. The code only works for exactly the change you were shown. A backup of your old file is kept.
4. Restart Gemini CLI.

Prefer to do it yourself? Run `npx -y @4thtech/agentlink init` in your own terminal. It shows the same change and asks `y/N`.

Check that the package name is exactly `@4thtech/agentlink`.

## 2. Protect your approvals

Do this yourself, in a terminal you opened, never through Gemini: [Protect your approvals](protect-your-approvals.md).

## 3. Check it works

Ask Gemini: "What's my AgentLink status?" If not, run `npx -y @4thtech/agentlink doctor` in your own terminal.

## Keep your AI away from AgentLink's files

Gemini CLI has a sandbox, but its documentation does not describe a way to block one folder such as `~/.agentlink`. So for Gemini CLI the folder guard isn't available, and the risk described in [Protect your approvals](protect-your-approvals.md) stays fully open. What you can do:

- **Keep Gemini's confirmation prompts on.** Never turn on "trust" for AgentLink in Gemini's settings.
- **Block the owner commands and keychain tools** with a rule file (below).
- **Run owner steps in a terminal you opened yourself.**

### Advanced: the rule file

Save this as `~/.gemini/policies/agentlink.toml`:

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["security ", "secret-tool ", "agentlink approve", "agentlink deny", "agentlink cancel", "agentlink owner", "agentlink policy"]
decision = "deny"
priority = 500
denyMessage = "Run this yourself, in your own terminal."
```

This is a guard that matches command text. It can be bypassed. The [technical reference](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/harness-configuration.md) has the details.

Source: [Gemini CLI policy engine](https://geminicli.com/docs/reference/policy-engine/) (`[[rule]]`, `toolName`, `commandPrefix`, `decision`, `priority` and `denyMessage` as shown there).

Next: [Pair with someone](pair-with-someone.md)
