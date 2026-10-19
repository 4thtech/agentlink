---
'@4thtech-io/agentlink': patch
---

M1-9h: `agentlink verify <proof.json>` checks a proof file from the proofs or inbox folder (D-87) over the shipped networks, prints the verdict first, labels test-network proofs with their network ID, shows one line per check and the specific reason for a pack that does not check out; exit codes 0 verified, 3 record only, 1 failed, 4 not checked, 2 usage. `agentlink credits [--topup]` shows the agent ID, credits in dollars and the proof price, and with `--topup` the amount to add on the cheapest network and the deposit page. `agentlink doctor` adds a proof network line.
