---
'@4thtech-io/agentlink': patch
---

M1-9d-2: the proof tools. New `agentlink_notarize`, `agentlink_acknowledge`, `agentlink_get_proof`, `agentlink_export_proof_pack` and `agentlink_verify_proof_pack` complete the 15-tool surface of 06 §2.0. `agentlink_send` takes `notarize` (the message is sent, then recorded under the `proofs.*` policy; the result adds `proof`), and the terms tools take `notarize` (refused with `NOTARIZE_UNAVAILABLE` until the core records offers and answers). `agentlink_status` adds `credits`, `prices` (USD with `protocolUsd` and `integratorUsd`), `agentAddress` and `topUpUrl`. Verifying a proof file by `path` is confined to the proofs and inbox folders (D-87). The CLI now wires the shipped chains into the core (read clients, chain-state ports, submitters) and declares `viem` as a runtime dependency, the same pinned version the bundled chain package already uses.
