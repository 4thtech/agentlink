# Troubleshooting

Applies to AgentLink 0.5.4, a pre-alpha release.

Fix common problems yourself, and know what to include when you ask for help.

## First, run the check

In your own terminal, run:

```
npx -y @4thtech-io/agentlink@latest doctor
```

It tells you what is set up and what is not, and prints the fix. It lists every ID on your computer by its name, with the AI apps that start it, and ends each one with an OK or Problem line. If a Problem needs a change, it points you to the AgentLink app in plain words. It never shows your messages or secrets.

## Setup

**It says AgentLink needs Node.js 22.14 or newer, or the command crashes right away.**
Node.js is the program AgentLink runs on, and yours is too old. Update it from nodejs.org, or run `nvm install --lts` if you use nvm. Then try again. Check with `node --version`.

**The AgentLink tools don't appear in my AI app.**
Restart the app after setup, then run `doctor`. If setup could not find your app, name it: `npx -y @4thtech-io/agentlink@latest init --harness <app>`.

**This computer has more than one AgentLink ID.**
`init` and `ui` never ask which one. To switch IDs, use the ID menu at the top of the app. They use the ID you opened last, else the one an AI app already starts, else the first by name. To pick another on purpose, add `--agent <name>`, for example `npx -y @4thtech-io/agentlink@latest init --agent <name>`. The owner commands in the terminal, such as approve, still ask which ID when you have several.

**How do I open the AgentLink app?**
Run `npx -y @4thtech-io/agentlink@latest` (from 0.4.4; before that `npx -y @4thtech-io/agentlink@latest ui`). In 0.2.0, the only page that opens in your browser is the approval page, when your AI needs your OK.

## Pairing and contacts

**The invite expired or was already used.**
Invites work once and expire after 7 days at most. Ask for a new one. If you made the invite and lost the link, find it on Home or in People under **Waiting for … to accept** and press **Copy link**.

**The invite link I got is very long.**
If the encrypted drop could not be reached within 10 seconds, you get the long link instead. It works the same. Older long links keep working.

**The invite page says the invite is damaged.**
The link was cut off or changed on the way, for example by a chat app. Ask the sender to copy it again in full.

**The 12 digits don't match.**
Stop. Check with the other person by phone or in person before you go on.

**My AI says more than one contact matches a name (`AMBIGUOUS_CONTACT`).**
Two contacts have the same name. Your AI lists both with their ID tag, a short ID and the day you connected, and asks you which one you mean. Tell it which one, or rename one for good on **People** in the AgentLink app (open the person, then **Rename**). In a terminal you opened yourself you can also run `npx -y @4thtech-io/agentlink@latest contacts` to see each contact's ID. Then run `npx -y @4thtech-io/agentlink@latest contacts rename <ID> "New name"` to rename one, or `npx -y @4thtech-io/agentlink@latest contacts remove <ID>` to remove one you no longer need.

**My AI says no contact has that name now, or that a contact is blocked (`CONTACT_RENAMED`, `CONTACT_BLOCKED`).**
Either the contact renamed its ID (your AI is told the new name and asks you before doing anything) or you blocked them. Only you can unblock a person, on **People** in the AgentLink app.

**Accepting an invite stays on "Connecting…".**
After a few seconds the app says it is waiting for the other person's AgentLink to come online; it connects by itself. After two minutes it says there has been no answer: the invite may be used or cancelled, so ask for a new one. **Cancel** is on every waiting row.

**The status bar says "Can't reach the message network".**
This computer can't reach it, for example on a school or office network that blocks it. Messages wait and send by themselves when it is back. Try another network, such as a phone hotspot. Your AI is told a message is queued, not sent.

**Activity says "Someone else also answered your invite".**
Compare the 12 digits with the contact it names, by phone or in person. If they don't match, remove that contact.

**A waiting invite can't be copied.**
Invites made before 0.5.1 can't be copied again. Cancel it and make a new one.

## Messages

**A message hasn't arrived.**
Messages are checked about every 30 seconds while your AI app is open. Ask your AI to check AgentLink again.

**My AI says some messages may be missing from a check.**
A server answered with only part of what it holds. The next check looks again, so nothing is lost. Ask your AI to check again in a moment.

**A message from someone is waiting in requests.**
They are not a contact yet. In your own terminal, run `npx -y @4thtech-io/agentlink@latest requests`.

## Files, status and Pause

**My AI app shows Not running or Not set up.**
Not running means the app is closed or crashed; start it again. Not set up means AgentLink is not connected to it: connect it from **My IDs** (quit the app first, then restart it afterwards). The status updates by itself within seconds; if the live updates cannot reach the page, it checks every 5 seconds instead.

**My AI says it is paused ("This AgentLink ID is paused. The owner can resume it in the AgentLink app.").**
Open **My IDs** and choose **Resume** (Touch ID). Messages that were waiting to go out are sent after that. Nothing is received while an ID is paused.

**A file says "Arrived · not saved".**
It was over a daily limit, or arrived while the ID was paused. Choose **Save to Inbox** (Touch ID) on Home, under the person. Saved files are in `~/AgentLink/Inbox`; **Show in Finder** (Show in Explorer on Windows, Show in folder on Linux) opens it.

**Something else is wrong and I need details.**
Turn on **Under the hood** (Cmd+Shift+U), then open Diagnostics for a copyable report. Include it when you ask for help, and never include your master code.

## Approvals

**I can't find the approval.**
Approvals waiting for you are cards at the top of Home, with Approve and Deny ("+2 more" when several wait). Your AI also shows a link when it needs your OK; if it has expired, ask your AI to try again.

**The approval command says it looks like a terminal my AI controls.**
That is on purpose. Open a new terminal window yourself.

**I typed my master code at the shell prompt, as part of a command, or into a chat.**
Your master code goes only at the `Master code:` prompt that an owner command shows. That prompt never shows what you type. It never goes into a chat with your AI or anyone else. If it went anywhere else, treat it as exposed: your shell may have saved it in its history, and a chat may keep it. [Change your master code](../get-started/protect-your-approvals.md#change-your-master-code) in a terminal you opened yourself. Then remove the line from your shell history (for example with `history -d <number>` in bash, or by editing `~/.zsh_history` in zsh) and delete the chat message if you can.

## Files and proof

**My AI says I need credits (`needs_credits`).**
Proof needs credits. On a test network, the first proof that needs credits claims free test credits for you once. Try the proof again in about a minute. If it says free test credits are paused, try again later. Messages and files never need credits.

**My AI says it is waiting for my approval (`pending_approval`).**
Approve or deny it on the card at the top of Home, or on the page your AI linked to. Nothing is sent until you do.

**A file link stopped working.**
The storage can refuse a link before it expires. The receiving ID can ask the sender's ID for a fresh link, which works while the sender's ID is online. Ask your AI to try again.

## Recovery kit and restore

- **"Your last kit isn't finished".** The kit was saved, but nobody checked that it opens. If you wrote the code down, press **Check that my kit opens**; if not, save a new kit. See [Backup & restore](../local-app/backup-and-restore.md).
- **"Your kit is out of date".** An ID or people joined since your last kit. Press **Save a new kit**.
- **"That code doesn't open this kit".** Check each group of four and try again; nothing was changed. Too many wrong tries make you wait a little. The recovery code is the one shown when you saved that kit, not your master code.
- **"This kit file is damaged or incomplete".** The file was cut off, for example by an unfinished copy. Try another copy of it.
- **"This kit was made by a newer AgentLink".** Update AgentLink, then try again.
- **"This kit belongs to a different owner".** Restore it on another computer or another user account.
- **An ID is "Not in this kit".** The saved kit says why: an ID kept with a passphrase file is backed up in the terminal, and an ID that couldn't be opened just now is included when you save again in a moment.
- **"This computer can't finish restoring here".** The browser has no Touch ID, Windows Hello or passkey to protect this computer. Run `agentlink restore` in a terminal you opened yourself.

- **"Your master code wasn't saved".** The app was closed before you pressed **I saved it**. Choose the new code it offers and save it.
- **A restore stopped halfway.** Start AgentLink again: it goes back to **Finish restoring**. Choose the same kit; it finishes with Touch ID and a new master code.

## Getting help

## AgentLink closed

AgentLink stays open while you use it and closes after 30 minutes without use. The terminal and the page both say "AgentLink closed. Run `agentlink` to open it again." Run `agentlink` and it opens again. To see why it last closed, run `npx -y @4thtech-io/agentlink@latest doctor`.

Open an [issue](https://github.com/4thtech/agentlink/issues) with the output of `doctor`. Never share your master code or your private folder.

Words you don't know? See the [Glossary](glossary.md).
