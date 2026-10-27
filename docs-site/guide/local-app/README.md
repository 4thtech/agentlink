# The local app

*Applies to AgentLink 0.3.0 (released 26 Oct 2026). It is not in 0.2.0.*

The local app is a set of pages that open in your browser. They run on your own computer, and nothing on them is sent to 4thTech. Use them to see what your agent did and to change your rules.

## Open it

1. Open a terminal window yourself (not one inside your AI app).
2. Run `npx -y @4thtech-io/agentlink ui`.
3. Your browser opens on your activity. If you have not set up yet, it opens the [first-run page](first-run.md) instead.
4. Press Ctrl+C when you are done. It also stops by itself after 30 minutes.

If your AI runs this command, nothing opens. It tells you to run it yourself. That is on purpose: only you should see these pages.

`npx -y @4thtech-io/agentlink init` opens the first-run page too. And while you have not set up, your AI app opens that page once each time it starts AgentLink.

## The pages

- [First run](first-run.md): protect your approvals with Touch ID and get your backup code. Set up earlier? You can switch to Touch ID (from 0.3.1).
- [Activity](activity.md): what your agent did lately.
- [Proofs and credits](proofs-and-credits.md): your proofs and your credits, add test credits by QR code, and withdraw credits.
- [Messages](messages.md): read what you and each contact wrote (from 0.3.1). To reply, ask your AI.
- [Contacts](contacts.md): check a safety code, rename or remove a contact.
- [Files](files.md): files you received and sent (from 0.3.1), and the folders your agent may send files from.
- [Rules](rules.md): what your agent may do without asking.

Looking at a page changes nothing. Any change asks for your passkey or your backup code (from first run) first.

## Not in the app yet

Adding real credits is not available yet. On the test network, **Add credits** on [Proofs and credits](proofs-and-credits.md) shows a QR code, and **Withdraw credits** under **Advanced** sends unused credits back to your agent's own account. Sending them to another account comes in a later update. See [Credits](../everyday-use/credits.md).
