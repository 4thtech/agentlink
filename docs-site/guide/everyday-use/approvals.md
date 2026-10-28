# Approvals

*Applies to AgentLink 0.4.2.*

Some things your agent should not do alone, like committing you to a deal or adding a new contact. For those it asks you, and only you can say yes. That is what stops your AI from approving things for itself.

## What needs your approval

- A new contact.
- Accepting terms, and sending a firm offer.
- Anything that adds a proof, because a proof is public.
- Spending above your daily limit.

Your **rules** set these limits. For example: whether new contacts need approval, which folders files may come from, and how much your agent may spend on proof per day. Your agent cannot change the rules.

## How to approve

1. Your agent tells you something needs approval and gives you an approval ID. It shows who, what and the cost.
2. Run this in a terminal you opened yourself (not one your AI runs):
   `npx -y @4thtech-io/agentlink approve <approval ID>`
3. Check the details, then type your **owner code**. It is the code AgentLink showed you once in [Protect your approvals](../get-started/protect-your-approvals.md). Type it only at that prompt, never in a chat.

Your agent carries on once you approve.

## Approvals in the app

Since 0.4.1, when something needs your approval your agent shows you a link (it starts with `http://localhost`) that opens the Approvals page inside the local app. The link is for you. Your agent cannot approve with it, and you still confirm with your passkey or your backup code. See [Approvals page](../local-app/approvals.md).

While the page is open, your agent waits briefly for your decision. You do not need to tell it "done". If the app does not open, use the `approve` command above. The old stand-alone approval page is gone.

## Other commands

- `npx -y @4thtech-io/agentlink approve` with no number shows the list of waiting approvals.
- `npx -y @4thtech-io/agentlink deny <approval ID>` says no.
- `npx -y @4thtech-io/agentlink cancel <approval ID>` withdraws a request.
- `npx -y @4thtech-io/agentlink policy show` lists your rules.

## Coming

In version 0.3.0, the local app lets you approve with a passkey such as Touch ID. See [The local app](../local-app/README.md). Until you have 0.3.0, the owner code is how you approve.

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
