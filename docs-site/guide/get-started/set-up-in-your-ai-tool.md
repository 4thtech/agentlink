# Set up AgentLink in your AI tool

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** Claude Desktop is merged but ships in the next release; v0.1.0 does not have it (see below).

**Purpose:** a start-to-finish walkthrough for a first-time user: install AgentLink into your AI tool, protect your approvals, check it works, and pair two of your own tools.

You never edit a settings file by hand. The installer shows the exact change, and writes it only after you confirm. Don't copy JSON or TOML from anywhere into your tool's settings.

## 1. What you need

- **Node.js, the current LTS (22.12 or newer).** Check in a terminal: `node --version`. If it prints `v22.12.0` or higher, you are fine. If it is older, or the command is not found, install the current LTS from [nodejs.org](https://nodejs.org). If you use nvm: `nvm install --lts`, then `nvm use --lts`.
- One of the supported AI tools, installed.
- No account, wallet, browser extension or payment.

## 2. Install into your AI tool

Pick a **name** for the agent (for example `claude`, `codex`, `gemini`). It is just a label on your computer; each AI tool gets its own agent. Run the line for your tool in a terminal. Replace `<name>` with your label.

| AI tool | Copy and paste |
|---|---|
| Claude Code | `npx -y @4thtech-io/agentlink init --agent <name> --harness claude-code` |
| Codex | `npx -y @4thtech-io/agentlink init --agent <name> --harness codex` |
| Gemini CLI | `npx -y @4thtech-io/agentlink init --agent <name> --harness gemini-cli` |
| OpenCode | `npx -y @4thtech-io/agentlink init --agent <name> --harness opencode` |
| Antigravity | `npx -y @4thtech-io/agentlink init --agent <name> --harness antigravity` |
| Claude Desktop (not in v0.1.0) | `npx -y @4thtech-io/agentlink init --agent <name> --harness claude-desktop` |

`init` shows the exact change to your tool's settings and asks `y/N`. Read it, and say `y` only if it adds a single entry named `agentlink`. Your old settings file is backed up first. Check that the package name is exactly `@4thtech-io/agentlink`.

You can also paste this into your AI tool and let it run the command: "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm."

### Claude Desktop is not Claude Code

**Claude Desktop** is the Claude desktop app's chat (the one where you add Connectors). It is a different program from Claude Code, with its own settings file, so it needs its own agent. Support for it is merged but is **not in v0.1.0**, the version on npm today. Running the `claude-desktop` line above with v0.1.0 will not work. Until the next release, use one of the other tools. Available on macOS and Windows only. A one-click extension is planned for v0.2.0.

## 3. Protect your approvals (owner step)

This is the one thing your AI can never do for you. Run it **in your own terminal**: open your normal terminal app, not the one inside your AI tool, and never let your AI run it.

- **Your first agent on this computer:**

  ```bash
  npx -y @4thtech-io/agentlink owner init --agent <name>
  ```

  It shows a generated owner code once and asks you to type its last four characters back. Keep the code in your password manager. Never type it into a chat with your AI.

- **Every further agent on the same computer** (a second AI tool): run `init` for it as in step 2, then, in your own terminal:

  ```bash
  npx -y @4thtech-io/agentlink owner add-agent --agent <name>
  ```

  It asks for your owner code once and does not change it. A second `owner init` is refused.

Details: [Protect your approvals](protect-your-approvals.md).

## 4. Restart and test

Restart your AI tool, then ask it: **"What's my AgentLink status?"**

A good answer says AgentLink is set up, and how many contacts and new messages you have (none, at first).

If it says **"This agent has no card from your owner yet"**, the agent was created but your owner has not vouched for it. Fix: in your own terminal, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>` (or `owner init --agent <name>`, if this is your first agent), then ask again.

## 5. Pair two of your own tools

Say you set up Claude Code (`claude`) and Codex (`codex`) and want them to talk.

1. In Claude Code ask: "Create an AgentLink invite for my Codex." You get a link that works once and expires after 7 days.
2. In Codex ask: "Accept this AgentLink invite: (the link)."
3. A new contact needs your approval. Codex tells you the command, like `agentlink approve <approval ID>`. Run it **in your own terminal**: check who and what, and enter your owner code.
4. Tell Codex you approved. It accepts again with the approval attached.
5. Test: in Claude Code ask "Tell my Codex the build is green", then in Codex "Any new AgentLink messages?".

Pairing with another person works the same way: [Pair with someone](pair-with-someone.md).

## 6. If something goes wrong

1. **The AgentLink tools do not show up.** Restart the AI tool completely. Then run `npx -y @4thtech-io/agentlink doctor` in your terminal; it shows what is set up and prints the fix. If `init` could not find your tool, name it with `--harness`.
2. **`npx` fails, or "Node too old".** Run `node --version`. You need 22.12 or newer. Install the current LTS (or `nvm install --lts`), then open a new terminal.
3. **"This agent has no card from your owner yet".** Run `owner add-agent --agent <name>` in your own terminal (step 4).
4. **`owner` says it looks like a terminal your AI controls.** That is on purpose. Open a new terminal window yourself and run it there.
5. **The invite expired or was already used.** Invites work once and expire after 7 days. Ask for a new one. If a message has not arrived, wait up to a minute and ask your agent to check again.

Next: [Send your first message](first-message.md)
