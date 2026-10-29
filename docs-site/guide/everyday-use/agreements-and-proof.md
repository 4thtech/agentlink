# Agreements and proof

*Applies to AgentLink 0.4.4. Proof runs on test networks only; it is free for now.*

Sometimes "we sent it" is not enough. You want to show later that this exact document, or these exact terms, existed at a certain time. That is what a proof is.

## What a proof is

A proof is a fingerprint of a message, file or offer, saved on a public record together with the time. A fingerprint is a short code made from the content. Change one letter and the code changes. The record never holds the content, names or file names.

After a proof, the other agent can add receipts: delivered, opened, accepted or rejected.

Anyone you give the proof to can check it without an account and without trusting 4thTech.

Proof is the only thing in AgentLink that costs money, and today it is free. See [Pricing](../pricing.md) and [Credits](credits.md).

## What a proof makes public

Your agent says this before the first proof of a session, and on every approval that adds a proof:

"A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says."

Also public:

- If the other side confirms delivery, anyone can see that it went to their agent. That is why delivery confirmations are off by default.
- When your agent opens, accepts or rejects something, that receipt is public too: anyone can see that your agent did it, and when.

More in [What leaves your computer](../privacy-and-security.md).

## Add a proof

1. Ask: "Send this to Marko with proof", or "Add proof to the message I sent Marko".
2. Your agent mentions the cost (unless you already asked for proof) and the notice above. Your rules can make it ask you first.
3. Approve it if asked. See [Approvals](approvals.md).
4. The proof is recorded about a minute later.

Free test credits are added automatically the first time. See [Credits](credits.md).

## Ask the other side to confirm delivery

Say: "Send this to Ana with proof and ask her to confirm delivery." Your agent first asks you: "Ask Ana to confirm delivery? If they do, anyone can see that this went to their agent."

On Ana's side, her agent says: "Ana asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content." Her agent confirms only if she chooses **Confirm delivery**. **Not now** sends nothing. If the message already had a proof, the request can no longer be added, and your agent tells you.

## Look at a proof

"Has Marko opened it?" Your agent shows the proof and its receipts. It adds an "opened" receipt only when you asked it to open a message, and "accepted" or "rejected" only with your approval.

## Proof of an agreement

A proof of agreement combines the final terms, their proof and the other side's "accepted" receipt. It shows that both agents agreed to exactly the same terms, and when. For example: "Terms recorded by Tali's agent on 12 Oct 2026 14:02. Accepted by Ana's agent 15:10." To record offers this way, see [Negotiating terms](negotiating-terms.md#adding-proof).

## What a proof does not show

- It does not move money.
- It does not by itself give an agreement legal effect.
- It does not prove who was authorised to sign.
- It does not show that the work was done, or that the content is true. It shows that this exact content existed and was sent at that time.

## Save and check a proof file

1. Ask: "Save a proof file." Your agent saves it in your proofs folder (`~/AgentLink/Proofs` by default). The message content goes into the file only after you approve it.
2. Give the file to anyone. The person you sent a proof to can save one too.
3. To check one, ask your agent: "Check this proof file." It can read a file from your proofs or inbox folder (never another folder) or one pasted into the chat. Or run this in a terminal:
   `npx -y @4thtech-io/agentlink verify ~/AgentLink/Proofs/<file>.json`

The first line says whether the proof checks out. "Record only" means the record is real, but the proof does not show who wrote the content. A proof on a test network is labelled "Test network" and is not a live proof.

Exit codes, if you script it: 0 verified, 3 record only, 1 does not check out, 4 not checked.

If the sender uses an account with its own rules (for example one shared by a team) and those rules changed since, the check says: "The signer's account no longer confirms this record. The proof network checked it when the record was made."

## Not available yet

- Proof on a main network. Proofs are recorded on public test networks only (see the [list of networks](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/networks-and-contracts.md)).
- A web page for checking a proof.
- Recording a rejection with proof.
- Turning delivery confirmations on automatically for a contact.

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
