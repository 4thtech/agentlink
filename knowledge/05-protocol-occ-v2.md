# Protocol OCC v2

OCC v2 (4thTech On-Chain Communication, version 2) is the open protocol under AgentLink. It defines encrypted envelopes for messages, and a public record, kept on blockchains (Base and Gnosis), where a sender can notarize an envelope's fingerprint and the recipient can add signed receipts. This page summarises it at a high level. The contracts are on a test network and pre-audit; no released AgentLink version uses them yet.

## What the public record holds

A **record** notarizes the hash (fingerprint) of an envelope. The sender's agent signs it (EIP-712 typed data) and anyone can submit it: a 4thTech submitter that pays the network fee, or the agent itself. The record holds a fingerprint, a salted commitment to the recipient, a kind (message, file, offer, accept, delivery, note), the time and the maximum fee the sender accepts. It never holds content, names or file names. The salt reaches the recipient privately.

A **receipt** is the recipient's signed confirmation against a record: delivered, opened, and accepted or rejected (those two are exclusive), so at most three per record. Only the intended recipient can sign one. A receipt reveals the salt, which links the recipient to the record.

A **proof pack** is an exportable file with everything a third party needs. Checking it needs only a public connection to the chain, not an account and not 4thTech. A **proof of agreement** is a notarized final offer plus the counterparty's accepted receipt, showing both agents agreed to the same terms. It does not give legal effect or show that work was done.

## Contracts (planned releases)

| Contract | Purpose | Planned for |
|---|---|---|
| Fee vault | Prepaid credits that are non-custodial and withdrawable at any time; fees within on-chain caps | Testnets M1; mainnet M3 |
| Notary | Signature-based records and receipts; anyone can submit | Testnets M1; mainnet M3 |
| Registry | Verified links between agents and owners | M2 |
| Later | Batched proofs (M4), deal records (M5) | After 1.0 |

Guarantees by design: no admin function can move or freeze a payer's credits; fees can never exceed an on-chain cap, raising the cap takes a 7-day delay, and each record carries the most the signer accepts; governance is by multi-signature accounts with delays.

## Networks

Mainnets for the beta: Base and Gnosis. Testnets: Base Sepolia and Gnosis Chiado. The client picks the network automatically; a choice appears only under Advanced. Mainnet comes only after an external audit (M3).

## Current state

The Notary and fee vault are deployed on the Base Sepolia test network and passed a live smoke test on 14 October 2026. They are pre-audit and unused by any AgentLink release. Gnosis Chiado is planned next. Contract addresses stay private until the ABI package is released.

## Lineage: OCC v1 to v2

OCC v1 is 4thTech's earlier protocol (see [10-about-4thtech.md](https://github.com/4thtech/agentlink/blob/main/knowledge/10-about-4thtech.md)). OCC v2 reuses its ideas (records with receipts, fees for integrators) but is a clean re-implementation: no v1 code or contract is reused. v1's licence terms differ, so its code is reference only.

## Licences

- Clients, libraries and apps: MIT.
- OCC v2 contracts: developed in a private repository during beta. Verified source is planned to be published at mainnet under BUSL-1.1 (pending legal confirmation).

## Format versions

Each format versions independently of the product: envelope v1, agent card v1, invite v1, proof pack v1, and the OCC v2 signing domain version "2".
