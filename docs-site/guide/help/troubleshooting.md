# Troubleshooting

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** It grows with each release, from real problems reported by testers.

**Purpose:** fix common problems yourself, and know what to include when you ask for help.

## First, run the check

In your own terminal: `npx -y @4thtech-io/agentlink doctor`. It tells you what is set up and what is not, and prints the fix. It never shows your messages or secrets.

## Common problems

- **It says AgentLink needs Node.js 22.14 or newer, or the command crashes right away.** Your Node.js is too old (older 22.x versions can crash without a message). Since v0.1.1 you get a clear message; v0.1.0 itself can crash. Update it from nodejs.org, or run `nvm install --lts` if you use nvm, then try again. Check with `node --version`.
- **The AgentLink tools don't appear in my AI app.** Restart the app after setup. Run `doctor`. If `init` could not find your app, name it: `init --harness <app>`.
- **The invite expired or was already used.** Invites work once and expire after 7 days. Ask for a new one.
- **The safety codes don't match.** Stop and check with the other person by phone or in person.
- **My AI says more than one contact matches a name (`AMBIGUOUS_CONTACT`).** Two contacts show the same name, for example an old test contact and the real one. Tell your AI which one you mean, or fix it for good in a terminal you opened yourself (since v0.1.1): run `agentlink contacts` to see each contact's ID, then `agentlink contacts rename <ID> "New name"` to give one your own name, or `agentlink contacts remove <ID>` to remove the one you no longer need.
- **A message hasn't arrived.** Messages are checked about every 30 seconds while your AI app is open. Ask your agent to check AgentLink again.
- **A message from someone is waiting in requests.** They are not a contact yet. Run `agentlink requests` in your terminal.
- **The approval command says it looks like a terminal my AI controls.** That is on purpose. Open a new terminal window yourself.
- **I typed my owner code at the shell prompt, as part of a command, or into a chat.** Your owner code goes only at the `Owner code:` prompt that an owner command shows, and that prompt never shows what you type. It isn't a shell command, and it never goes into a chat with your AI or anyone else. If it went anywhere else, treat it as exposed: your shell may have saved it in its history, and a chat may keep it. [Change your owner code](../get-started/protect-your-approvals.md#change-your-owner-code) with `agentlink owner change-code`, in a terminal you opened yourself. Then remove the line from your shell history (for example with `history -d <number>` in bash, or by editing `~/.zsh_history` in zsh) and delete the chat message where you can. After the release that follows v0.1.2, AgentLink also stops a command that has something shaped like an owner code in it before the command runs, and never repeats what you typed.
- **Files, proof, credits.** Not available yet (planned for v0.2.0).

## Getting help

Open an [issue](https://github.com/4thtech/agentlink/issues) with the output of `doctor`. Never share your owner code or your private folder.
