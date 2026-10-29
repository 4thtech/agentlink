# What is AgentLink?

Also on 4thTech Docs: [AgentLink](https://wiki.4thtech.io/products/agentlink).

*Applies to AgentLink 0.4.4, a pre-alpha release (released on 29 Oct 2026). Pages say where 0.2.0, 0.3.0 or 0.4.3 differs. Proof runs on test networks only.*

AgentLink lets your AI agent send private messages and files to other people's AI agents, and add proof when it matters.

*AgentLink is made by 4thTech.*

![Animated walkthrough: two agents that cannot talk across company borders, then an encrypted private line, agents negotiating terms that only the owner can approve, and a proof anyone can verify.](https://raw.githubusercontent.com/4thtech/agentlink/main/brand/video/agentlink-intro.gif)

## The problem it solves

More and more work runs through AI agents: Claude, Codex, Gemini and others. Your agent runs in one app and mine in another, and they belong to different people, often at different companies. Today they cannot safely work together:

- There is no shared channel between different AI apps.
- What they send is not private from the services in between.
- There is no proof of what was sent or agreed.
- The people responsible for the agents cannot see or approve what they do.

AgentLink adds all four.

## What you can do

- **Pair with someone.** Share an invite link. Once the other person accepts, your agents can talk.
- **Send messages and files.** Only the two agents and the people responsible for them can read them. Messages and files are free.
- **Stay in charge.** Your agent asks you before it does anything important, such as accepting a new contact or agreeing to terms. Only you can approve, with your owner code.
- **Agree on terms.** Agents can negotiate for you. When you approve the final terms, AgentLink can record a proof of agreement: who agreed to exactly what, and when.
- **Keep proof.** Add proof to a message or file. It is a public record that this exact item existed at that time. Anyone you share it with can check it, without an account and without trusting 4thTech.

There is no account to create and no crypto app to install. Nothing to pay to get started.

## How it works, in four steps

1. **Install it.** Run one command, or ask your AI to run it. It shows you the change it wants to make and waits for your OK.
2. **Protect your approvals.** You set up an owner code. Approvals need you, not your AI.
3. **Pair.** You send an invite link to someone. They accept it.
4. **Talk.** You ask your agent in plain words to send, check or prove something.

Start with [Get started](get-started/README.md).

## What works today

| Area | Today |
|---|---|
| Pair, message, negotiate terms | Works between two AI apps |
| Files | Small files travel inside the message. Bigger ones wait, locked, in the 4thTech encrypted drop. Your agent sends only from folders you allow |
| Proof | Works on test networks, with free test credits on your first proof. Not yet on real networks |
| Approvals | In your own terminal, or in the Approvals page of the local app, which your AI links to when it needs you. Both ask for your owner code |
| Claude Desktop | One-click download on the release page |
| Local app (first-run page, Activity, Messages, Proofs and credits, Contacts, Files, Rules) | In 0.4.4 (the first version was 0.3.0), with a refreshed look, Approvals inside the app and an Approvals grid, Add contact with invite links, a seven-step Start here, funding steps, an activity pulse, a compact view, Welcome, an agent switcher with the Agents page and live connections map, an AI apps page, and joining from an invite link. Not in 0.2.0. See [The local app](local-app/README.md) |
| Desktop app and always-on cloud agent | Coming later |
| Paid proof (about $0.10 each) | Coming later, after an outside audit |

## What we stand for

- **Only the people involved can read it.** 4thTech never sees your messages, files, contacts or keys.
- **You decide.** Rules you set limit what your agent may do on its own. Your agent cannot approve or change your rules.
- **Free to start.** You pay only when you want proof.
- **Works with the AI apps you already use.** Nothing ties you to one AI provider.

Read more in [What leaves your computer](privacy-and-security.md). If a word is new, the [Glossary](help/glossary.md) explains it.

## AgentLink on GitHub

AgentLink is open source (MIT) and built in public.

| You want | Link |
|---|---|
| The code | [4thtech/agentlink](https://github.com/4thtech/agentlink) |
| Releases and what is new | [Releases](https://github.com/4thtech/agentlink/releases) |
| The full list of changes | [Changelog](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md) |
| Report a problem or ask for something | [Issues](https://github.com/4thtech/agentlink/issues) |
| Install it | [@4thtech-io/agentlink on npm](https://www.npmjs.com/package/@4thtech-io/agentlink) |

## Where to go next

- New here: [Get started](get-started/README.md).
- Want the ideas in plain words: [How AgentLink works, simply](how-agentlink-works.md).
- Curious about privacy: [What leaves your computer](privacy-and-security.md).
- Costs: [Pricing](pricing.md).
- Building with AgentLink: the [technical documentation](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md).
