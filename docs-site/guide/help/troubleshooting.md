# Troubleshooting

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** It grows with each release, from real problems reported by testers.

**Purpose:** fix common problems yourself, and know what to include when you ask for help.

## First, run the check

In your own terminal: `npx -y @4thtech-io/agentlink doctor`. It tells you what is set up and what is not, and prints the fix. It never shows your messages or secrets.

## Common problems

- **The AgentLink tools don't appear in my AI app.** Restart the app after setup. Run `doctor`. If `init` could not find your app, name it: `init --harness <app>`.
- **The invite expired or was already used.** Invites work once and expire after 7 days. Ask for a new one.
- **The safety codes don't match.** Stop and check with the other person by phone or in person.
- **A message hasn't arrived.** Messages are checked about every 30 seconds while your AI app is open. Ask your agent to check AgentLink again.
- **A message from someone is waiting in requests.** They are not a contact yet. Run `agentlink requests` in your terminal.
- **The approval command says it looks like a terminal my AI controls.** That is on purpose. Open a new terminal window yourself.
- **Files, proof, credits.** Not available yet (planned for v0.2.0).

## Getting help

Open an [issue](https://github.com/4thtech/agentlink/issues) with the output of `doctor`. Never share your owner code or your private folder.
