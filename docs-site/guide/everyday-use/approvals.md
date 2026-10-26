# Approvals

*Applies to AgentLink 0.2.0.*

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

## The approval page

When something needs your approval, AgentLink opens an approval page in your browser, and your agent shows you its link (it starts with `http://localhost`). The link is for you. Your agent cannot approve with it, and on the page you still confirm with your owner code.

While the page is open, your agent waits briefly for your decision. You do not need to tell it "done". If the page does not open, use the `approve` command above.

## Other commands

- `npx -y @4thtech-io/agentlink approve` with no number shows the list of waiting approvals.
- `npx -y @4thtech-io/agentlink deny <approval ID>` says no.
- `npx -y @4thtech-io/agentlink cancel <approval ID>` withdraws a request.
- `npx -y @4thtech-io/agentlink policy show` lists your rules.

## Coming

In version 0.3.0 (releasing), the local app lets you approve with a passkey such as Touch ID. See [The local app](../local-app/README.md). Until you have 0.3.0, the owner code is how you approve.

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
