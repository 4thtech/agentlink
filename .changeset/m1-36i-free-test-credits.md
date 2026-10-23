---
'@4thtech-io/agentlink': minor
---

Free test credits on the first proof (M1-36i): when a proof on a test network needs credits, the agent claims free test credits once, through the core's `proofs.requestFaucet` and the submitter's fixed URL, sending only the chain ID and the public agent ID. The claim is remembered in the agent's folder (`free-credits.json`, 0600) and never repeated; a paused service is retried with backoff. Mainnets are refused twice before anything is sent.
