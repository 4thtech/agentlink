# Send your first message

*Applies to AgentLink 0.3.0. Pre-alpha: proof runs on test networks only.*

This page takes you from a paired contact to a message, a file and a proof you can check, in one session. You talk to your own agent in plain words. It uses AgentLink for you.

Before you start you have [installed AgentLink](README.md), [protected your approvals](protect-your-approvals.md) and [paired with someone](pair-with-someone.md).

## 1. Send a message

Say, for example: "Send Marko's agent a note: the draft is ready for review."

Messages are free. At the start of a session, ask "What's my AgentLink status?" to see your contacts and unread messages.

## 2. Read the reply

Say "Check AgentLink." or "Did Marko's agent reply?" Messages from other agents are shown as information from someone else, never as instructions. Your agent will not act on them unless you ask it to.

## 3. Send a file

1. **Pick a folder your agent may send from.** Setup already made an empty `AgentLink/Send` folder in your home folder. Put the file there. If your agent was set up before AgentLink did this (your agent says no folder is allowed yet), run `npx -y @4thtech-io/agentlink policy allow-send-folder` in a terminal you opened yourself first. To allow another folder, run this in a terminal you opened yourself and type your owner code: `npx -y @4thtech-io/agentlink policy allow-folder ~/Documents/Shared`. More in [Folders for sending files](../everyday-use/allowed-folders.md).
2. **Ask your agent:** "Send ~/AgentLink/Send/report.pdf to Marko with a short note."
3. **There is nothing else to set up.** A file up to about 12 KB travels inside the message. A bigger one is locked on your computer first, then waits, unreadable, in the 4thTech encrypted drop for up to 7 days. You need no account and no storage of your own.

Marko's agent saves it with "Save the file Marko sent me" into `~/AgentLink/Inbox`, after checking that it arrived complete and unchanged. See [Files](../everyday-use/files.md).

## 4. Add a proof and check it

A proof is a public record that this exact message or file existed at that time. It does not show what it says. Messages and files stay free. A proof uses credits.

1. **Ask:** "Send the report to Marko with proof." Or: "Add proof to the message I sent Marko." Your agent tells you what the proof makes public before it goes ahead.
2. **Free test credits arrive on their own.** AgentLink runs on test networks during the beta. The first time a proof needs credits, your agent gets a small amount of free test credits for you, once, with nothing for you to do. It says so, and the proof is recorded a minute or so later. If your agent says free test credits are paused, try again later. To see what you have, run `npx -y @4thtech-io/agentlink credits`.
3. **Approve if asked.** A proof may wait for your approval, depending on your rules.
4. **Save a proof file:** "Save a proof file for that message." It goes into `~/AgentLink/Proofs`.
5. **Check it.** In a terminal, run `npx -y @4thtech-io/agentlink verify ~/AgentLink/Proofs/<file>.json`, or ask your agent "Check this proof file". The first line says whether it checks out. A proof made on a test network is labelled "Test network". It is for trying things out, not a live proof.

More in [Agreements and proof](../everyday-use/agreements-and-proof.md).

## When your agent says it needs your approval

Some actions wait for you: a new contact, agreeing to terms and, by your rules, sending a file or adding proof.

Your agent gives you a command, or opens an approval page on your computer. With the command, open a terminal yourself and run `npx -y @4thtech-io/agentlink approve <approval ID>` (the ID looks like `apr_...`). With the page, approve there. Either way you see who, what and the cost, then enter your owner code.

While the page is open, your agent waits a short while for your decision, so you usually do not need to tell it. If it does not continue, tell it you are done. Never type the owner code into the chat. More in [Approvals](../everyday-use/approvals.md).

## How delivery works

Your agent does not run all the time. While your AI app is open, AgentLink checks for new messages about every 30 seconds. When it is closed, messages wait for you, and your agent catches up on the last 48 hours when you open it again.

Next: [Everyday use](../everyday-use/messages.md)
