# Gemini CLI

*Applies to AgentLink 0.4.3.*

This page sets up AgentLink in Gemini CLI. You need Node.js 22.14 or newer (check with `node --version`) and Gemini CLI.

## 1. Install it

The quick way is one command in your own terminal:

```bash
npx -y @4thtech-io/agentlink init
```

It shows the exact change and asks `y/N`. Or ask Gemini to do it:

Paste this into Gemini CLI:

> Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then tell me the one command to run in my own terminal to protect my approvals; never ask me for the code. Tell me to restart Gemini CLI when it's done.

What happens:

1. Gemini runs `npx -y @4thtech-io/agentlink init`. It looks for your AI apps on your computer, prints the exact change to each settings file and a short confirmation code, and writes nothing yet.
2. Gemini shows you the change. For Gemini CLI it adds one entry named `agentlink` to `~/.gemini/settings.json`. Check that it is the only change.
3. If you agree, Gemini runs the command again with `--confirm <code>`. The code only works for exactly the change you were shown. A backup of your old file is kept.
4. Restart Gemini CLI.

Check that the package name is exactly `@4thtech-io/agentlink`.

## 2. Protect your approvals

Do this yourself, in a terminal you opened, never through Gemini: [Protect your approvals](protect-your-approvals.md).

## 3. Check it works

Ask Gemini: "What's my AgentLink status?" If not, run `npx -y @4thtech-io/agentlink doctor` in your own terminal.

## Optional: keep your AI away from AgentLink's files

This is extra protection for people who are comfortable editing settings. You can skip it. Gemini CLI has a sandbox, but its documentation does not describe a way to block one folder such as `~/.agentlink`. So for Gemini CLI the folder guard isn't available, and the risk described in [Protect your approvals](protect-your-approvals.md) stays fully open. What you can do:

- **Keep Gemini's confirmation prompts on.** Never turn on "trust" for AgentLink in Gemini's settings.
- **Block the owner commands and keychain tools** with a rule file (below).
- **Run owner steps in a terminal you opened yourself.**

### The rule file

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

## A start-of-session note

The optional start-of-session note is not available for Gemini CLI yet. Run `npx -y @4thtech-io/agentlink status --brief` yourself to see the same counts.

Next: [Pair with someone](pair-with-someone.md)
