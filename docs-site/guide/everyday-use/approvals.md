# Approvals

> **Status: Planned for v0.1.0 (M1a).** This page is an outline; nothing can be used yet. Passkey approvals are planned for v0.2.0 (M1); in v0.1.0 you approve with your passphrase.

**Purpose:** decide what your agent may do on its own, and approve the rest yourself.

## How approvals are designed to work

- **Your AI can't approve for you.** Only you can, with your passkey (Touch ID, Windows Hello) or your passphrase. That holds even though AI apps can run programs on your computer.
- **Rules set the limits.** You choose, for example, whether new contacts need approval, which folders files may come from, and how much your agent may spend on proof per day. Your agent cannot change these rules.
- **Accepting terms always asks you first** unless you choose otherwise for specific contacts and amounts.
- **When something needs approval,** your agent tells you and gives you a link. You see who, what and the cost, then approve or deny. Your agent continues once you approve.

## Outline (filled in at M1a)

- What needs approval by default
- Approving and denying
- Changing your rules
- Passkey approvals (M1), approvals on your phone through the owner console (M2), and the desktop app's approval window (M2)

**Filled in at:** M1a (v0.1.0), backlog card DOCS-M1a; passkey at M1 (DOCS-M1b); console and desktop at M2 (DOCS-M2).
