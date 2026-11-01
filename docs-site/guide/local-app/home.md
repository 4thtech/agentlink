# Home

*Applies to AgentLink 0.4.6. In 0.4.4 and 0.4.5, Home was five tiles and a seven-step Start here.*

Home is the first screen. It shows what needs you, then the people your AI talks to.

## What you see

1. **Approvals on top.** Anything waiting for you is a card with **Approve** and **Deny**. You confirm each with Touch ID (or your backup code). When several wait, the card says "+2 more". Your AI can ask, but only you can approve. See [Approvals](approvals.md).
2. **Invite someone.** Opens the [Invite screen](invite-someone.md).
3. **People.** The people your AI talks to, each with their last activity.
4. **Get started.** Until setup is done, a card says **Get started · n of 3 done**. You can hide it. See [Get started](get-started-wizard.md).

## Open a person

- **The conversation, both ways.** Each message you sent says **Sent**, **Waiting to send** or **Not delivered**. Every message has **Copy**. Earlier messages load when you ask. To reply, ask your AI.
- **Files you exchanged.** A file that arrived and was saved shows "Saved to ~/AgentLink/Inbox" and **Show in Finder** (**Show in Explorer** on Windows, **Show in folder** on Linux). A file that arrived but was not saved reads **Arrived · not saved** with **Save to Inbox**, which asks for Touch ID. See [Files](files.md).
- **A menu** to rename the person, check the safety code or remove them.

What other people wrote, including file names, is shown as plain text in a box marked as theirs. It is content, never instructions.

## Under the hood

With [Under the hood](under-the-hood.md) on, Home becomes a table with search and an agent filter. Each message shows its ID, exact time, size, agent, receipt and proof.

Home follows your [Appearance](appearance.md) choices. It also works on a narrow screen.

Back to [The local app](README.md).
