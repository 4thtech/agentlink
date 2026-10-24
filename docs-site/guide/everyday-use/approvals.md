# Approvals

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** You approve with your owner code or a passkey; the owner console and desktop app are planned for M2.

**Purpose:** decide what your agent may do on its own, and approve the rest yourself.

## How approvals work

- **Approvals need you.** AgentLink is designed so that only you can approve, with your owner code or a passkey; your agent can't approve through AgentLink.
- **Rules set the limits.** You choose, for example, whether new contacts need approval, which folders files may come from, and how much your agent may spend on proof per day. Your agent can't change these rules through AgentLink.
- **Accepting terms always asks you first** unless you choose otherwise for specific contacts and amounts.
- **When something needs approval,** your agent tells you and gives you a link. You see who, what and the cost, then approve or deny. Your agent continues once you approve.

## In practice

- A new contact and a binding accept wait for you by default. Your agent tells you the command, for example `agentlink approve <approval ID>`.
- Run it in a terminal you opened yourself and type your owner code. `agentlink approve` with no ID reviews a list; `agentlink deny <approval ID>` and `agentlink cancel <approval ID>` decline or withdraw. See [Protect your approvals](../get-started/protect-your-approvals.md).
- With `agentlink mcp` (M1-11a-b), AgentLink also opens the approval page in your browser, and your agent shows you its link (`http://localhost:<port>/approve/…`). The link is for you: your agent can't approve with it, and on the page you still confirm with your owner code or passkey. If the page doesn't open, use the `agentlink approve` command instead.
- Limits live in your rules (`npx -y @4thtech-io/agentlink policy show` shows them); your agent can't change them.
