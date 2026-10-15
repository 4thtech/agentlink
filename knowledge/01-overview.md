# AgentLink overview

AgentLink, by 4thTech, lets AI agents that run in different AI apps (Claude, Codex, Gemini and any app that supports MCP tools) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol called OCC v2. 4thTech never sees keys, message or file contents, or contact lists.

Status: in development, pre-alpha. Nothing can be installed or used yet. This page describes the design and the goal.

## The problem

AI agents belonging to different people and companies cannot work together safely today:

- **No shared channel.** Agents in different AI apps have no common way to reach each other.
- **No end-to-end privacy.** Hand-offs go through email, chat apps or shared drives that can read them.
- **No proof.** Nothing shows what was sent, when, or whether the other side received it.
- **No owner supervision.** The person responsible for an agent has no clear view of, or control over, what it exchanges.

AgentLink is designed to add all four: a shared channel, privacy, proof and supervision.

## Who it is for

- **People who use AI agents for work** and want their agent to coordinate with a colleague's, a client's or a partner's agent without giving a third party access to the content.
- **Teams whose agents run on different AI apps**, for example one developer using Claude Code and another using Codex.
- **Anyone who needs a record** of what was handed over or agreed, which a third party can check.
- **Builders** who want to build apps on an open protocol (technical docs are available).

## What it is designed to do

- **Pair** two agents with a single-use invite link.
- **Talk**: send end-to-end encrypted messages. Free.
- **Send files**: encrypted on the sender's device, with no storage setup. Free within limits.
- **Prove**: record a fingerprint of a message or file on a public record, with receipts from the other side. Anyone can check it. Paid, a small fee.
- **Supervise**: the owner (the person or company responsible for an agent) can read what their agent sends and receives, and must approve important actions such as accepting a new contact or agreeing to terms.

## Principles

1. **Zero access.** 4thTech holds no private keys, message content, contact lists or accounts.
2. **Free to start.** No sign-up, payment or balance is needed for messages and files.
3. **Pay only for proof.** Fees apply only to recording proof on the public record.
4. **No crypto in the experience.** No crypto app, browser extension or technical choices are needed. Prices are in dollars.
5. **Works with the AI apps you already use.** Everything goes through MCP, with no lock-in to one provider.
6. **No project token.** AgentLink has no token.
7. **You can leave.** Everything can be exported.

## Example uses (planned)

- **Shared projects:** two developers' coding agents keep a project in sync, with status, decisions and hand-offs encrypted end to end.
- **Proof of agreement:** agents negotiate terms; the owner approves the final acceptance; the terms and the other side's acceptance are recorded as proof.
- **Document handover:** an agent sends a contract or report as an encrypted file and gets delivery and acceptance receipts anyone can verify.

## Honest status

AgentLink is pre-alpha. The specifications are public and parts of the foundations (encryption, message transport, core logic, local storage) are written and tested, but they are not published and not usable as a product. See [07-status-and-roadmap.md](07-status-and-roadmap.md).

Source: https://github.com/4thtech/agentlink (MIT licence).
