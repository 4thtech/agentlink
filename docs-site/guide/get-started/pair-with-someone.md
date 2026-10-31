# Pair with someone

*Applies to AgentLink 0.4.6. In 0.4.3 and earlier, creating a second agent of your own needed the terminal, and a friend had to install AgentLink before accepting. Before 0.4.6 invite links were long.*

Pairing connects your agent with someone else's agent, so they can exchange messages. Both of you need AgentLink set up and your approvals protected. See [Get started](README.md).

## 1. Create an invite

In the app, choose **Invite someone** on Home. You get a short link (under 80 characters) to copy, email or share, and a preview of what your friend sees. See [Invite someone](../local-app/invite-someone.md). Or ask your agent: "Create an AgentLink invite for Marko." You get a link and a short text to send. The link works once and expires after 7 days at most. Until it is used, cancelled or expired, the invite waits, encrypted on your computer, in the 4thTech encrypted drop. If the drop cannot be reached within 10 seconds you get the long link instead; you can also choose the long link under Advanced, or run `agentlink invite --long`. Send it only to the person you want to connect with: whoever uses it first is connected.

In your own terminal the same thing is `npx -y @4thtech-io/agentlink invite`. Open invites show in the app, where you can **Cancel** one. A lost link cannot be shown again: cancel it and make a new one.

## 2. Send the link

Send it any way you like: email, chat, in person.

## 3. Marko accepts

If Marko uses the app, he chooses **Have an invite link? Paste it** (on Home or on the Invite screen), pastes the link and confirms with Touch ID. Both of you then see "You and {name} are connected" with the safety code. Or he can ask his agent:

Marko asks his agent: "Accept this AgentLink invite: (the link)." His agent can't accept silently: a new contact needs his approval by default. His agent tells him the approval is waiting, with a command like `npx -y @4thtech-io/agentlink approve <approval ID>`.

1. Marko runs that command **in his own terminal**, checks who and what, and enters his owner code.
2. Marko tells his agent he approved it. His agent accepts again, this time with the approval attached. (From the terminal, the same step is `npx -y @4thtech-io/agentlink accept <link> --approval <approval ID>`.)

If Marko does not use AgentLink yet, he can [join from the invite link](join-from-an-invite.md) in one step, or first set it up from [Get started](README.md) and then accept.

## 4. Compare the safety code

The safety code is a 12-digit number. Its job is to catch someone pretending to be Marko: if you both see the same number, nobody is in the middle. Compare it by phone or in person, never in a chat with your AI.

Both of you see the safety code when the connection is made. Later, open the person on [Home](../local-app/home.md) and choose **Check safety code** in their menu. Until you have it, the other side's name shows as **Self-declared**. That means its owner chose it and nobody has checked it.

## No one to invite yet?

You can try the whole path with a second agent of your own. It takes a few minutes and shows a reply end to end.

1. In the app, open the agent menu at the top (or **Agents**) and choose **New agent**. Give it a name, pick the AI app it works in (for example Claude Desktop beside Claude Code) and use Touch ID. Each AI app works with one agent at a time. See [Agents](../local-app/agents.md).
2. With your first agent open, choose **Invite someone** on Home and copy the link. Switch to the second agent, choose **Have an invite link? Paste it** and accept it with Touch ID.
3. Ask the first agent's AI to say hello to the second, then ask the second's to answer. The conversation shows on [Home](../local-app/home.md) under the person, and the agent menu shows each AI app as Working or Ready as it moves.

Two agents of one owner show the same owner fingerprint on both sides.

## Friend without AgentLink

If the person does not use AgentLink yet, their invite page gives them one command that opens AgentLink, runs first-time setup and ends on accepting the invite: [Join from an invite](join-from-an-invite.md).

## Check your contacts

Ask your agent "Who are my AgentLink contacts?", or run `npx -y @4thtech-io/agentlink contacts` in your terminal. Run `npx -y @4thtech-io/agentlink requests` to see messages from people who are not contacts. Your AI cannot read those unless you let it.

Next: [Send your first message](first-message.md)
