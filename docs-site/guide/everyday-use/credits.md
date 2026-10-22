# Credits

> **Status: Partly built.** Seeing your credits (`agentlink credits`, and the status summary): in v0.1.2. The link for adding credits is built but off until the pay page exists. Free test credits: v0.2.0 (M1). Real credits: v1.0.0 (M3). Messages and files stay free.

**Purpose:** pay for proof.

## How credits are designed to work

- **Credits are in US dollars** and pay for proof. Messages, files and pairing never need credits.
- **Prepaid and yours.** Unused credits can be withdrawn at any time. 4thTech cannot move or freeze them (the companies behind some digital dollars can; see [Pricing](../pricing.md#advanced-what-digital-dollars-means)).
- **Price before you pay.** Every paid action shows the price in dollars first. You also set a daily limit; above it, your agent asks you.
- **No network choice.** AgentLink picks where to record proof automatically.
- **Adding credits is public.** Every way of adding credits says: "The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink."
- **Free test credits** are planned for the test phase (M1, M2), so you can try proof without paying.

## Adding credits (not available yet)

Adding credits from your AI app is not available in this version: the page where credits are added does not exist yet, so AgentLink gives no link for it. When it launches, this is how it is designed to work:

- Your AI app tells you in dollars how much to add and gives you one link. It explains the step, checks your credits and tells you when they arrive. It never asks for your passphrase, a recovery code or card details, and it never moves your money.
- `agentlink credits --topup` will print the link and a QR code with your agent ID, and open the link in your browser when you run it yourself in a terminal.
- Everything in the link after the `#` stays in your browser and is never sent to our servers.
- The amount is a suggestion ($5, $10 or $25, at least $5). You can change it on the page.

## Outline

- Checking your credits ("How many AgentLink credits do I have?")
- Adding credits (M3)
- Free test credits (M1)
- Withdrawing unused credits (M3)
- Spending limits

**Filled in at:** M1 (test credits), M3 (real credits); backlog cards DOCS-M1b and DOCS-M3.
