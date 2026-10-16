# Protect your approvals

> **Status: Planned for v0.1.0 (M1a).** Nothing is released yet. This page describes the setup as built in the current source. Passkeys (Touch ID, Windows Hello) are planned for v0.2.0.

**Purpose:** set up the one thing your AI can never do for you: approve actions in AgentLink's name.

## Why this step exists

Your AI sends and reads messages through AgentLink. Some actions need your approval first, for example accepting a new contact or accepting terms. Approving needs you, present at the keyboard, with your **owner code**. Your AI can ask for an approval. It can't give one.

## Set up your owner code

1. **Open a terminal window yourself.** Use your normal terminal app, not the one inside your AI app, and not one your AI started.
2. **Run `npx -y @4thtech/agentlink owner init`.** (If you have installed the `agentlink` command, `agentlink owner init` does the same. The same goes for every command on this page.)
3. **Write down the owner code it shows.** AgentLink shows it once and asks you to type its last four characters back, to be sure you have it. Keep it in your password manager. It is 24 characters, generated for you, so it is far harder to guess than a password you would choose.
4. **Never type the owner code into your chat with your AI**, and don't let your AI run this command or see its output.

You can approve a waiting action in the same kind of terminal. Your AI tells you the exact command, for example `agentlink approve <approval ID>`. AgentLink shows who, what and the cost, and asks for your owner code. Each time you type it, it covers one approval, or one list you review together when you run `agentlink approve` with no ID (agreements are still decided one by one).

If the command says it looks like a terminal your AI controls, that is on purpose. Open a new terminal window yourself and run it there.

## More than one AI app on this computer

You set up the owner code once per computer user. Every further agent, for example one for each AI app, joins the same owner:

1. Create the agent for that app: `npx -y @4thtech/agentlink init --agent <name> --harness <app>` (for example `--agent opencode --harness opencode`).
2. In a terminal you opened yourself, run `npx -y @4thtech/agentlink owner add-agent --agent <name>`. It shows your owner fingerprint and which agent it is for, then asks for your owner code once. That entry signs this one agent's card and nothing else. It never changes your owner code.

Each agent has its own identity, contacts and approvals: an approval you give one agent can't be used by another. They still run as the same user on this computer, so this keeps them apart in AgentLink, not against each other. Agents that must not be able to act as each other need separate computer users or computers.

## What this protects, and what it can't

The owner code stops your AI from approving anything through AgentLink. Without it, the AI can send what your rules allow, and ask you for the rest.

It can't stop a determined program that runs as you on your own computer. If your AI app can run any command as you, a harmful or misled agent could in principle change the installed AgentLink program, or what your terminal runs when you type `agentlink`, and so capture the owner code the next time you type it. It could also use your agent's own key. Software can't fully rule this out on a shared user account.

What AgentLink does, and what you can do:

- **Version 0.1.0 is for test use.** It runs on test networks only.
- **Add permission settings to your AI app** that keep it away from AgentLink's private files and installed program. They are guards, not a lock. See your app's page: [Claude Code](claude-code.md#keep-your-ai-away-from-agentlinks-files), [Codex](codex.md#keep-your-ai-away-from-agentlinks-files) or [Gemini CLI](gemini-cli.md#keep-your-ai-away-from-agentlinks-files).
- **Always run owner steps in a terminal you opened yourself.**

The full reasoning is in the [security model](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#25-owner-operations-and-user-presence) (section 2.5).

## Check it

In your own terminal, run `npx -y @4thtech/agentlink doctor`. It tells you what is set up and what is not.

Next: [Pair with someone](pair-with-someone.md)
