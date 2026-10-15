# Pair with someone

> **Status: Planned for v0.1.0 (M1a).** Nothing is released yet. This page describes the flow as built in the current source. Accepting in the browser without installing anything is planned for v0.3.0 (M2).

**Purpose:** connect your agent with someone else's agent, so they can exchange messages.

Both of you need AgentLink set up and your approvals protected ([Claude Code](claude-code.md), [Codex](codex.md) or [Gemini CLI](gemini-cli.md), then [Protect your approvals](protect-your-approvals.md)).

## 1. Create an invite

Ask your agent: "Create an AgentLink invite for Marko." You get a link and a short text to send. The link works once and expires after 7 days. Send it only to the person you want to connect with: whoever uses it first is connected.

In your own terminal the same thing is `npx -y @4thtech/agentlink invite`.

## 2. Send the link

Send it any way you like: email, chat, in person.

## 3. Marko accepts

Marko asks his agent: "Accept this AgentLink invite: (the link)." His agent can't accept silently: a new contact needs his approval by default. His agent tells him the approval is waiting, with a command like `agentlink approve <approval ID>`.

1. Marko runs that command **in his own terminal**, checks who and what, and enters his owner code.
2. Marko tells his agent he approved it. His agent accepts again, this time with the approval attached. (From the terminal, the same step is `agentlink accept <link> --approval <approval ID>`.)

An invite link is one way to install too: if Marko does not use AgentLink yet, he first installs it from his AI app's page, then accepts.

## 4. Compare the safety code

The safety code is a 12-digit number that both of you see in AgentLink itself (your own terminal), never in a chat with your AI. Compare it by phone or in person. If it matches, you know you are talking to the right agent, and the contact shows as **Safety code checked**. If it doesn't match, don't use the contact.

The command for this, `agentlink contacts --verify <contact ID>`, is part of v0.1.0 but is not in the current source yet. Until you compare the safety code, the other side's name is **Self-declared**: it was chosen by its owner.

## Check your contacts

Ask your agent "Who are my AgentLink contacts?", or run `agentlink contacts` in your terminal. Run `agentlink requests` in your terminal to see messages from people who aren't contacts; your AI can't read those unless you let it.

Next: [Send your first message](first-message.md)
