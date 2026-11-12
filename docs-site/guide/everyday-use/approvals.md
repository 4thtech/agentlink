# Approvals

*Applies to AgentLink 0.4.8.*

Some things your AI should not do alone, like committing you to a deal or adding a new contact. For those it asks you, and only you can say yes. That is what stops your AI from approving things for itself.

## What needs your approval

- A new contact.
- Accepting terms, and sending a firm offer.
- Anything that adds a proof, because a proof is public.
- Spending above your daily limit.

Your **rules** set these limits. For example: whether new contacts need approval, which folders files may come from, and how much your AI may spend on proof per day. Your AI cannot change the rules.

## How to approve

1. Your AI tells you something needs approval and gives you an approval ID. It shows who, what and the cost.
2. Run this in a terminal you opened yourself (not one your AI runs):
   `npx -y @4thtech-io/agentlink@latest approve <approval ID>`
3. Check the details, then type your **master code**. It is the code AgentLink showed you once in [Protect your approvals](../get-started/protect-your-approvals.md). Type it only at that prompt, never in a chat.

Your AI carries on once you approve.

## Approvals in the app

When something needs your approval, it appears as a card at the top of [Home](../local-app/home.md) in the local app, with **Approve** and **Deny**. You confirm with Touch ID (or your master code). When several wait, Home shows the first and **+2 more**. With Under the hood on, several free requests can be approved together; anything that costs money or commits you is approved one at a time. Your AI also shows you a link (it starts with `http://localhost`) that opens the same request. The link is for you. Your AI cannot approve with it. See [Approvals page](../local-app/approvals.md).

While the page is open, your AI waits briefly for your decision. You do not need to tell it "done". If the app does not open, use the `approve` command above. The old stand-alone approval page is gone.

## Other commands

- `npx -y @4thtech-io/agentlink@latest approve` with no number shows the list of waiting approvals.
- `npx -y @4thtech-io/agentlink@latest deny <approval ID>` says no.
- `npx -y @4thtech-io/agentlink@latest cancel <approval ID>` withdraws a request.
- `npx -y @4thtech-io/agentlink@latest policy show` lists your rules.

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
