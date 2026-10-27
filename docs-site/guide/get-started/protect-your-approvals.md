# Protect your approvals

*Applies to AgentLink 0.3.0 (released 26 Oct 2026). The recommended way is the setup page: one Touch ID (or Windows Hello), and a backup code. The terminal way, `owner init`, with an owner code, still works and is the only way in the published 0.2.0.*

## Why this step exists

Your AI sends and reads messages through AgentLink. Some actions need your approval first, for example accepting a new contact or agreeing to terms. If your AI could approve for itself, approvals would mean nothing. So approving needs you, at the keyboard, with your **owner code**. Your AI can ask for an approval. It cannot give one.

This takes about a minute.

## Set up your owner code in the terminal

This is the terminal way. In 0.3.0 the [setup page](#the-setup-page-030) opens from `init` and does the same job. Use the terminal way if no browser opens or you prefer it.

1. **Open a terminal window yourself.** Use your normal terminal app, not the one inside your AI app, and not one your AI started.
2. **Run `npx -y @4thtech-io/agentlink owner init`.**
3. **Write down the owner code it shows.** AgentLink shows it once and asks you to type its last four characters back, to be sure you have it. Save it in your password manager right away. Nobody can recover it, not even 4thTech: without it you cannot approve anything for this agent, and you would have to set up a new agent and pair again. It is 24 characters and generated for you, so it is far harder to guess than anything you would make up. Setup also creates an empty `AgentLink/Send` folder in your home folder, the first place your agent may send files from.
4. **Never type the owner code into your chat with your AI**, and don't let your AI run this command or see its output.

You approve a waiting action in the same kind of terminal. Your AI tells you the exact command, for example `npx -y @4thtech-io/agentlink approve <approval ID>`. AgentLink shows who, what and the cost, and asks for your owner code. Some approvals open a page on your computer instead. It asks for the same code. Each time you type it, it covers one approval, or one list you review together when you run `approve` with no ID (agreements are still decided one by one).

What can wait for you in a first session: a new contact, agreeing to terms and, depending on your rules, a file you ask your agent to send or a proof it adds. Free test credits for your first proof need no approval. They are added once for you, on test networks only.

If the command says it looks like a terminal your AI controls, that is on purpose. Open a new terminal window yourself and run it there.

## More than one AI app on this computer

You set up the owner code once per computer user. Every further agent, for example one for each AI app, joins the same owner:

1. Create the agent for that app: `npx -y @4thtech-io/agentlink init --agent <name> --harness <app>` (for example `--agent opencode --harness opencode`).
2. In a terminal you opened yourself, run `npx -y @4thtech-io/agentlink owner add-agent --agent <name>`. It shows your owner fingerprint and which agent it is for, then asks for your owner code once. That entry signs this one agent's card and nothing else. It never changes your owner code.

If you removed every agent that had a card but your owner is still set up on this computer, `owner add-agent` still works: your owner code unlocks the saved owner first, then it shows your owner fingerprint and asks you to confirm it's the one you saw at `owner init` before it signs the card.

Each agent has its own identity, contacts and approvals: an approval you give one agent can't be used by another. They still run as the same user on this computer, so this keeps them apart in AgentLink, not against each other. Agents that must not be able to act as each other need separate computer users or computers.

## Change your owner code

If your owner code was exposed, for example typed into a chat with your AI or into a terminal your AI can read, replace it:

1. **Open a terminal window yourself**, as for `owner init`.
2. **Run `npx -y @4thtech-io/agentlink owner change-code`.** It asks for your current owner code first. Three wrong entries end the command and nothing changes.
3. **Write down the new owner code it shows**, and type its last four characters back. Keep your current code too until the command says the owner code changed; only then discard the old one.

Your owner fingerprint stays the same and your agents keep their cards, so your contacts see no change. From then on only the new code works. If anything fails before the change is complete, your current code keeps working. If a change was interrupted, `doctor` says so: run `owner change-code` again, and it finishes or cleans up the earlier change. If you saved a recovery kit, it isn't changed: it has its own recovery code.

Changing the code doesn't protect copies of the old saved owner key made earlier, for example in a backup, from someone who also has the old code. If you think that happened, set up a new owner and agent.

## Which browser for a passkey (0.3.0)

From 0.3.0 the local page can use a passkey (Touch ID on a Mac, Windows Hello on Windows) instead of typing your owner code. It should work in Safari on a recent Mac, or an up-to-date Chrome, Edge or Firefox using your system's own passkey. Older Windows versions don't support it, and some browsers and password managers reportedly don't either. If yours can't, nothing breaks: you'll use your owner code instead. We are still testing each browser and will update this note.

## The setup page (0.3.0)

From 0.3.0 the setup page in your browser does this step for you. It first shows the folders it creates: `~/AgentLink/Send`, `~/AgentLink/Inbox` and `~/AgentLink/Proofs`. Then it has one button, for example **Use Touch ID**. That one touch protects your approvals, sets up your agent and lets your AI send files you put in `~/AgentLink/Send`, nothing else.

The page then shows **your backup code** once. Press **Save in my password manager**, then **I saved it**. The backup code approves when Touch ID isn't available, for example in another browser. Never give it to your AI. If `~/AgentLink/Send` already holds files, or isn't a plain folder, the page asks you to fix that before you touch the sensor.

## Already set up in the terminal? Switch to Touch ID

If you set up your owner code with `owner init` (as in 0.2.0), the local app shows **Switch to Touch ID** (or Windows Hello) on every page until you do it. Press it, enter your owner code once (the app calls it your backup code), then touch the sensor. Your owner and your agents stay the same. Your code keeps working as the backup way to approve, for example in another browser or in the terminal. Your AI can open the page, but it can't switch for you: it needs your code and your touch.

## What this protects, and what it can't

The owner code stops your AI from approving anything through AgentLink. Without it, the AI can send what your rules allow, and ask you for the rest.

It can't stop a determined program that runs as you on your own computer. If your AI app can run any command as you, a harmful or misled agent could in principle change the installed AgentLink program, or what your terminal runs when you type `agentlink`, and so capture the owner code the next time you type it. It could also use your agent's own key. Software can't fully rule this out on a shared user account.

What AgentLink does, and what you can do:

- **AgentLink is pre-alpha.** It runs on test networks only.
- **Add permission settings to your AI app** that keep it away from AgentLink's private files and installed program. They are guards, not a lock. See your app's page: [Claude Code](claude-code.md#optional-keep-your-ai-away-from-agentlinks-files), [Codex](codex.md#optional-keep-your-ai-away-from-agentlinks-files) or [Gemini CLI](gemini-cli.md#optional-keep-your-ai-away-from-agentlinks-files).
- **Always run owner steps in a terminal you opened yourself.**

More on what stays on your computer: [What leaves your computer](../privacy-and-security.md).

## Check it

In your own terminal, run `npx -y @4thtech-io/agentlink doctor`. It tells you what is set up and what is not.

Next: [Pair with someone](pair-with-someone.md)
