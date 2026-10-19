# Folders for sending files

> **Status: In the next release (not in v0.1.1).** The `agentlink policy` command for allowing folders is built and comes with the next release, together with sending files through your agent ([Files](files.md)). A settings page for the same rules arrives with the local settings page.

**Purpose:** choose the folders your agent may send files from.

## How it works

- **Nothing is allowed until you allow it.** Your agent can send a file only from a folder you allowed. Until you allow one, a request to send a file stops before anything is read, and your agent tells you what to do.
- **Only you can change this.** Allowing or removing a folder is part of your rules, signed with your owner code. Your AI can't change your rules, and there is no AI tool for it.
- **The whole folder, its subfolders, no hidden files.** Allowing a folder allows the files in it and in its subfolders. Hidden files (such as `.env`) and private folders (such as `~/.ssh` and AgentLink's own folder) can never be sent, even from an allowed folder.
- **The real folder, not a link.** AgentLink stores the folder's real path. A path that goes through a link (a shortcut) is refused, and you are shown the real path to use instead.
- **Not too wide.** You can't allow your whole computer or your whole home folder. Allow a folder inside it, for example a `~/Documents/Shared` folder you keep for sharing. You can allow up to 32 folders.
- **No folder that holds a private folder (coming soon).** A folder that contains a private folder, such as `~/Library` (which holds your passwords in `~/Library/Keychains`), will be refused before you're asked for your owner code. AgentLink names the private folder and asks you to choose a smaller folder. Until then, files inside private folders are still refused when your agent tries to send them.

## In practice

In a terminal you opened yourself (not one your AI runs):

1. `agentlink policy allow-folder ~/Documents/Shared` allows that folder. AgentLink shows the exact folder, then asks for your owner code.
2. `agentlink policy show` lists your allowed folders and a few other rules, such as where received files are saved. It doesn't ask for your owner code.
3. `agentlink policy remove-folder ~/Documents/Shared` stops your agent from sending files from that folder. This works even if you already deleted the folder.

Type your owner code only at the prompt, never in a shell command or a chat. A wrong code changes nothing; run the command again to retry. Add `--agent <name>` if you have several agents.

If AgentLink says it can't read your rules, nothing is changed and no folder is allowed: run `agentlink doctor` in your own terminal. A command to repair your rules, `agentlink policy recover`, is coming soon: it will show what went wrong, show you the full rules it would sign (your last rules if they can still be trusted, otherwise the starting rules), and sign them only after you type `y` and your owner code.

## Still to come

- Changing other rules from the terminal (`agentlink policy set`), such as the limits for agreements.
- Refusing a folder that holds a private folder, and `agentlink policy recover` (both above).
- The local settings page for the same rules.

**Filled in at:** M1 (v0.2.0), backlog card M1-9m.
