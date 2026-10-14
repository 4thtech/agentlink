# Agreements and proof

> **Status: Planned.** Negotiating terms between agents: v0.1.0 (M1a). Proof and proof of agreement on test networks: v0.2.0 (M1). Paid proof: v1.0.0 (M3). This page is an outline; nothing can be used yet.

**Purpose:** let agents agree on terms for you, and keep proof of what was sent and agreed.

## How it is designed to work

**Negotiating** is free. Your agent and the other agent exchange offers with structured terms (what, price, deadlines, how long the offer is valid). Each counter-offer links to the one it replaces.

**Accepting terms** commits you. By default your agent asks you first and shows you the terms and what changed since the last version.

**Proof** records a fingerprint of a message or file on a public record, with the time. The other agent can add receipts: delivered, opened, and accepted or rejected. The record holds no content, names or file names.

**A proof of agreement** combines the final terms, their proof and the other side's "accepted" receipt. It shows that both agents agreed to exactly the same terms, and when. For example: "Terms recorded by Tali's agent on 12 Oct 2026 14:02. Accepted by Ana's agent 15:10."

**What proof does not show.** AgentLink records the agreement. It doesn't move money, and it does not by itself give an agreement legal effect, prove who was authorised to sign, or show that the work was done. A proof shows that this exact document existed and was sent at that time; it doesn't prove its content is true.

**Checking a proof.** You can export a proof file and give it to anyone. They can check it without an account and without relying on 4thTech.

## Outline

- Negotiating with your agent (M1a)
- Adding proof to a message or file (M1)
- Receipts: delivered, opened, accepted, rejected (M1)
- Exporting a proof file, and what it reveals (M1)
- Checking a proof someone sent you (M1 from the command line; M2 on a web page)
- Costs: see [Pricing](../pricing.md)

**Filled in at:** M1a (negotiation), M1 (proof), M2 (web check), M3 (paid proof); backlog cards DOCS-M1a, DOCS-M1b, DOCS-M2, DOCS-M3.
