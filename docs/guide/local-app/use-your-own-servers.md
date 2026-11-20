# Use your own servers

<!-- ai-knowledge: summary
summary: How to choose the message servers that carry your messages, under Under the hood › Message network: add and test servers, the list of 2 to 8, the owner approval, the 30 days old servers stay readable, the "Don't also announce on the default servers" option, reset to automatic, and the terminal commands. Most people never need it. -->

*Coming in 0.5.15 (not released yet).*

AgentLink picks the message servers for you, and most people never need to change that. If you run servers yourself, or your company wants everything on servers it trusts, you can choose them. It lives under Under the hood, so nothing about it shows on a normal screen.

## Do it in the app

1. Turn on **Under the hood**, then open Settings › Advanced › Message network.
2. In the card "Want to use servers you run or trust?", press **Use your own servers**.
3. Type the server (it starts with `wss://`) and press **Add**. AgentLink tests each server right away, on this computer. The test sends one throwaway test message made just for the test. It never uses your ID, and it reads nothing of yours.
4. Read the result next to each server:
   - **Ready**, with its answer time. It accepts and returns messages.
   - **Ready · slow**. It works but answers slowly, so messages may arrive a little later.
   - **Needs sign-in to read**. It accepts messages but asks for a sign-in before anyone can read them. AgentLink can't sign in there, so it can't confirm delivery on that server. It is allowed only when at least 2 other servers of your list work.
   - **Doesn't accept messages**, **Didn't keep the test message**, **Can't reach**, **Messages too large for it**, **Not allowed** or a "Not a server" notice. Each comes with a short reason.
   A server that may charge for use gets a warning.
5. Build a list of 2 to 8 servers. Keep **Also use AgentLink's automatic servers** on and AgentLink mixes in two healthy automatic servers, so your messages still arrive if yours go down. Those two count toward the 8. You need at least 2 of your own servers that are ready; one is not enough, because if it goes down your messages stop.
6. Press **Review**. The review shows every server, how long your old servers stay readable, that your contacts will get your new details, and what servers can see: that you're online, and scrambled messages, never what's inside them. Nothing changes until you approve.
7. Approve with Touch ID (or your computer's own sensor) or your master code. AgentLink then tells your contacts your new details for you; ones that are offline get them when they're back.

Public servers only: the server must start with `wss://`, and servers inside a home or office network are blocked for your safety. AgentLink never asks you to add a server. Only add servers you run or trust. Servers should keep messages for at least 7 days.

## What happens to your old servers

Servers that leave your list stay readable for 30 days, so nothing sent to them is missed. You can change your list again, or go back to automatic, at any time. If too many old servers are still being read, the app says so and offers to go back to automatic.

## Back to automatic

Press **Use AgentLink's automatic servers**. It takes one approval, AgentLink picks the servers for you again, and your own list is forgotten on this computer. Your custom servers stay readable for 30 days.

## Don't also announce on the default servers

For companies that run everything on their own servers. The switch is offered only when **Also use AgentLink's automatic servers** is off. With it on, AgentLink is fully quiet toward the public default servers: it sends nothing to them and reads nothing from them. The one exception is a server a contact lists, which is used for that contact only. Your own previous servers stay readable for 30 days.

What you give up:

- Another computer can find this ID only with your owner link or a backup.
- Contacts that still have an old copy of your contact details may not reach you until they receive the update.
- If all your servers are down, nothing gets through until one is back.

A restore from your recovery kit keeps this choice.

## Do it in the terminal

Run these yourself in a terminal you opened. An AI app can't run `set` or `reset`, and no AI tool can change your servers.

```
agentlink owner servers list
agentlink owner servers test wss://one.example wss://two.example
agentlink owner servers set wss://one.example wss://two.example
agentlink owner servers reset
```

- `list` (also plain `owner servers`) shows your servers with their state, the automatic mix-in, the announce choice and the old servers with the date they stop being read. `test` runs the same test as the app. Neither needs approval.
- `set` shows the same review, asks "Continue?", then asks for your master code. Add `--no-automatic` to leave out the automatic servers, and `--no-announce` for the option above (it needs `--no-automatic`).
- `reset` goes back to automatic, with one approval.
- Add `--json` to `list` or `test` for output a program can read.

## Good to know

- Only you can do it. It needs Touch ID or your master code.
- The test shares the app's limit of 10 tests a minute.
- A paused ID must be resumed before you change servers.

Back to [Under the hood](under-the-hood.md) or [The local app](README.md).
