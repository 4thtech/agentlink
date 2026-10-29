---
'@4thtech-io/crypto': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

U3-e: remove an agent from the app (D-138, 08 §1, 04 §2.5). `POST /api/ui/agents/remove {name, typedLabel, anyway?}` is a new named route kind `remove`: it is refused with `in_use` while any process has the agent open (the shared folder lock), checks the typed label, and with one owner gesture always signs `agent.revoke {reason: "retired"}` for the agent, records it in the owner's revoked list (`~/.agentlink/revoked/<agentId>.json`, re-verified as the signed object), marks the agent `removing`, tells its contacts with owner-signed `revoke` envelopes (bounded wait; `undeliverable` asks before going on), erases its keys through the new KeyStore erase API (`KeyEraseControl` in `@4thtech-io/crypto`, keychain and file backends in `@4thtech-io/node`; never an owner item) and deletes its folder, inside the exclusive folder lock. `backup restore` refuses an agent that is in the revoked list.
