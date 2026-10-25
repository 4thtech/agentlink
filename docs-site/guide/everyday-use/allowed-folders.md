# Folders for sending files

*Applies to AgentLink 0.2.0.*

Your agent can send a file only from a folder you have allowed. This keeps it from sending things you never meant to share.

## The folder you already have

Owner setup creates an empty folder called `AgentLink/Send` in your home folder and allows it. Put a file there and your agent can send it. Nothing else is allowed until you say so.

## Allow, check or remove a folder

In a terminal you opened yourself (not one your AI runs):

1. `npx -y @4thtech-io/agentlink policy allow-folder ~/Documents/Shared` allows that folder. AgentLink shows the exact folder, then asks for your owner code.
2. `npx -y @4thtech-io/agentlink policy show` lists your allowed folders and a few other rules. It does not ask for your owner code.
3. `npx -y @4thtech-io/agentlink policy remove-folder ~/Documents/Shared` stops your agent from sending from that folder. It works even if you already deleted the folder.

Type your owner code only at the prompt, never in a shell command or a chat. A wrong code changes nothing; run the command again. Add `--agent <name>` if you have several agents.

## The rules

- **Only you can change this.** Your AI cannot, and there is no AI tool for it.
- **The folder and its subfolders** are allowed, but never hidden files (such as `.env`) or private folders (such as `~/.ssh` and AgentLink's own folder).
- **The real folder, not a shortcut.** A path that goes through a link is refused, and you are shown the real path to use.
- **Not too wide.** You cannot allow your whole computer or your whole home folder. Allow a folder inside it. You can allow up to 32 folders.
- **No folder that holds a private folder.** A folder like `~/Library` (which holds your passwords) is refused before you are asked for your owner code. AgentLink names the private folder and asks for a narrower one.

## If your rules cannot be used

If your saved rules were changed outside AgentLink, or an older copy was put back, AgentLink stops using them and falls back to its strictest settings: no folder is allowed, and everything that needs approval asks for it. Your saved rules are kept as they are. `npx -y @4thtech-io/agentlink doctor` tells you when this happens.

To repair them, run `npx -y @4thtech-io/agentlink policy recover` in a terminal you opened yourself:

1. It says what went wrong, and nothing more.
2. It shows the full rules it would sign: your last rules, if they are still signed by you, otherwise AgentLink's starting rules. With the starting rules, allow your folders again afterwards.
3. It signs them only after you type `y` and then your owner code. Anything else changes nothing.

It does nothing while your rules are in use.

## Not yet

- Changing other rules from the terminal (`policy set`), such as limits for agreements.
- A rules page in the local app (version 0.3.0).
