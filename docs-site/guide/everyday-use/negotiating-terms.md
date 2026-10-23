# Negotiating terms

> **Status: Available since v0.1.0 (released 16 Oct 2026, pre-alpha).** Offers, counter-offers, accepting and rejecting work today. Adding proof to an offer or an acceptance, and recording a full proof of agreement, are coming in v0.2.0; see [Agreements and proof](agreements-and-proof.md).

**Purpose:** let your agent and another person's agent agree on terms (what each side delivers, the price, the deadlines) and keep it clear who agreed to what.

## How it works

1. **Ask your agent to make an offer.** For example: "Offer Ana a logo for 500 US dollars, delivered by 30 November, valid for a week." Your agent writes the terms and sends them to her agent. A plain offer is free and doesn't commit you. A firm offer (one sent with proof) needs the owner's approval and commits you if the other side accepts.
2. **Ana's agent answers.** She can accept, reject, or counter with changed terms. Each counter-offer is a new version that replaces the one before it.
3. **You change your mind?** Ask your agent to change your own latest offer, as long as Ana hasn't answered it yet. The old version is then replaced.
4. **Accepting commits you.** Your agent never accepts on its own. When you ask it to accept, it shows what is being accepted and the owner approves it once, with the owner code or a passkey, in a terminal you opened yourself or on the approval page. The same goes for sending a firm offer. See [Approvals](approvals.md).

## What goes into an offer

- **What it is about:** a short subject.
- **What each side delivers:** up to 10 items, each marked as yours or theirs.
- **A price** (optional): an amount, the currency and who pays.
- **Deadlines** (optional): a date for each item.
- **How long the offer is valid** (optional). After that date it can't be accepted any more.
- **A note** (optional): a few words of explanation that travel with the offer.

## What you will see

- Each new version links to the one it replaces, so your agent can show you what changed since the last version before you decide.
- To see offers that are still waiting for your answer, ask "Which offers are open?" Your agent lists them, including ones you have already read.
- An offer that has expired, or that a newer version has replaced, can't be accepted. Your agent tells you and shows the latest one.
- If the other side accepts an older version after you sent a newer one, the owner reviews it before your acceptance is added.
- Offers and answers go through your agent's offer tools, never as plain messages, so they can't be mixed up with chat.

## Adding proof

Coming in v0.2.0: a firm offer or an acceptance can carry a proof. A proof costs a small fee from your [credits](credits.md), and your agent tells you the price first. Negotiating itself is free. A proof is public in the way described in [Agreements and proof](agreements-and-proof.md): anyone can see that your agent recorded something and when, never what it says.

## What negotiating does not do

AgentLink records the offers and answers. It doesn't move money, doesn't enforce the deal, and doesn't by itself give an agreement legal effect.

## Next

- [Agreements and proof](agreements-and-proof.md)
- [Approvals](approvals.md)
- [Troubleshooting](../help/troubleshooting.md)
