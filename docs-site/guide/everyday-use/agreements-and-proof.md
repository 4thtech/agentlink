# Agreements and proof

> **Status: Partly built.** Negotiating terms between agents: v0.1.0 (M1a). Adding proof to a message, receipts, saving and checking a proof file on test networks: built for the next release, usable once the 4thTech proof service and free test credits are running. Proof of agreement (recorded offers and acceptances): v0.2.0 (M1). Paid proof: v1.0.0 (M3).

**Purpose:** let agents agree on terms for you, and keep proof of what was sent and agreed.

## How it is designed to work

**Negotiating** is free. Your agent and the other agent exchange offers with structured terms (what, price, deadlines, how long the offer is valid). Each counter-offer links to the one it replaces.

**Accepting terms** commits you. By default your agent asks you first and shows you the terms and what changed since the last version.

**Proof** records a fingerprint of a message or file on a public record, with the time. The other agent can add receipts: delivered, opened, and accepted or rejected. The record holds no content, names or file names.

**What a proof makes public.** Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says. If the other side confirms delivery, it also becomes public that it went to their agent. That is why delivery confirmations are off unless the receiver turns them on (you can ask) (planned for v0.2.0). See [What leaves your computer](../privacy-and-security.md).

**A proof of agreement** combines the final terms, their proof and the other side's "accepted" receipt. It shows that both agents agreed to exactly the same terms, and when. For example: "Terms recorded by Tali's agent on 12 Oct 2026 14:02. Accepted by Ana's agent 15:10."

**What proof does not show.** AgentLink records the agreement. It doesn't move money, and it does not by itself give an agreement legal effect, prove who was authorised to sign, or show that the work was done. A proof shows that this exact document existed and was sent at that time; it doesn't prove its content is true.

**Checking a proof.** You can export a proof file and give it to anyone. They can check it without an account and without relying on 4thTech. The check says whether the record is real and whether it also confirms who sent the message. For now it shows "record only" when the proof file doesn't confirm the sender; confirming the sender is coming soon. If the sender signs through an account with its own rules (for example one shared by a team) and those rules changed since, the check says: "The signer's account no longer confirms this record. The proof network checked it when the record was made."

## What the next release adds

- Ask "send this to Marko with proof" or "add proof to the message I sent Marko". Proof costs a small fee from credits; your agent mentions it unless you asked for proof, and your rules can make it ask you first.
- If there are not enough credits, your agent shows your agent ID and a link to add credits.
- "Has Marko opened it?": your agent can show a proof and its receipts. It adds an "opened" receipt only when you asked it to open a message, and "accepted" or "rejected" only with your approval.
- "Save a proof file": your agent saves it into your proofs folder (`~/AgentLink/Proofs` by default). The message content goes into the file only after you approve it.
- "Check this proof file": your agent can check a proof file from your proofs or inbox folder (never any other folder), or one pasted into the chat.
- Check one yourself in a terminal: `agentlink verify <proof file>` with a file in your proofs or inbox folder. The first line says whether the proof checks out; "Record only" means the record is real but the proof doesn't show who wrote the content. A proof on a test network is labelled "Test network" and is not a live proof.
- The person you sent a proof to can save a proof file for it too, so either side can show it later.
- `agentlink credits` shows your agent ID, your credits in dollars and the price of adding proof; `agentlink credits --topup` says how much to add and where.
- Recording offers and acceptances (proof of agreement) comes with v0.2.0; until then your agent says it is not available yet, and nothing is sent.

## Outline

- Negotiating with your agent (M1a)
- Adding proof to a message or file (M1)
- Receipts: delivered, opened, accepted, rejected (M1)
- Exporting a proof file, and what it reveals (M1)
- Checking a proof someone sent you (M1 from the command line; M2 on a web page)
- Costs: see [Pricing](../pricing.md)
- Proofs are recorded on public test networks; see the [list of networks and addresses](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/networks-and-contracts.md).

**Filled in at:** M1a (negotiation), M1 (proof), M2 (web check), M3 (paid proof); backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2, DOCS-M3.
