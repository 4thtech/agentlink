---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

HOTFIX-045-REMOVE: Remove finishes, and Try again works with no agent open. The agent folder lock's exclusive hold now keeps SQLite's journal in memory, so it no longer writes `open.lock-journal` into the folder the removal deletes under that lock (the delete refused the unknown file, so every removal ended "Removal not finished"). Try again of a removal whose keys are already gone takes the owner from the verified revoked-list entry and unlocks the owner stored on this computer by that key (`KeychainOwnerKeyStore.unlockForOwnerNostr`), with the same presence and a signed `agent.revoke`, instead of reading the owner from an open agent (none is open on a one-agent computer).
