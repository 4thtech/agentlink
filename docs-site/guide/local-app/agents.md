# Agents page and the agent switcher

*Applies to AgentLink 0.4.4. In 0.4.3 the app shows one agent and you choose it in the terminal.*

An agent is one identity of yours: its own contacts, messages and files. Most people have one. You may want a second to try AgentLink on your own, or one per project. All your agents live in the same window.

## Switch between agents

The top bar shows the open agent: its name, the AI app it works from and whether it is **Running**. Press it to see your agents and pick another. You can also press **Switch** on the Agents page.

Switching asks for no Touch ID, because it approves nothing. The page then shows the other agent's own contacts, messages and files. If a page was still showing the first agent, it is refreshed before it can change anything, so a change can never land on the wrong agent.

Every agent that was already on your computer is listed, under the name it had. Nothing is renamed or lost when you update.

## The list

**Agents** in the menu opens the list. Each row shows the agent's name, whether it is **Running** or **Not running**, which AI app it **Works from** (or **Not connected to an AI app**) and how many contacts it has. A row has **Switch**, **Rename**, **Connect an AI app** or **Connect**, **More** and, for the open agent, **Open**.

If some of your agents are not connected to an AI app and have no contacts, a calm note offers **Tidy up**. If they were only for testing, you can remove them.

## Add an agent

1. Press **Add agent**.
2. Name it, for example **Second agent**.
3. Press **Add with Touch ID**.

AgentLink makes the agent, signs it as yours and names it in that one step. If anything fails, nothing is left behind. Adding an agent never changes your AI apps' settings. The sheet then asks **Connect an AI app to it?**, which you can answer with **Not now**.

An agent made here belongs to you, like your first. Two agents of one owner can pair with each other: this is the easy way to try AgentLink without a second person. See [Pair with someone](../get-started/pair-with-someone.md#no-one-to-invite-yet).

## Rename

**Rename** changes only the name you see. It never changes the agent's folder, its AI app entries or its identity. It asks for Touch ID.

## Remove an agent

**More**, then **Remove**, retires an agent for good. The sheet names what goes from this computer: its keys and settings, its message and file history, and its entry in an AI app. It also says how many contacts will be told the agent is retired.

1. If an AI app still uses the agent, the sheet says **Quit any AI app that uses** the agent **first.** Close the app, then **Check again**.
2. You can **Export history first** to keep a copy.
3. Type the agent's name to confirm, then press **Remove with Touch ID**.
4. If your contacts can't be told right now, the sheet asks **Remove anyway?** before it goes on.

It can't be undone, and a removed agent can't be restored from a backup: it can only come back as a new agent. Your owner identity and your other agents stay.

## Live connections

The **Map** view next to **List** shows who your agents are talking to, right now. Each agent is a box with its AI app. Its contacts sit on the right (the top 12, then **+N more**), and a line appears for people who exchanged something in the last 24 hours. A short dash travels along the line while a message or file is moving. Quiet contacts are behind **Show quiet**. Press a box or a line to open that conversation in [Messages](messages.md).

The map shows names and words only, never message content. With reduced motion nothing travels and the word **now** shows instead. The list is the text version of the same facts.

Back to [The local app](README.md).
