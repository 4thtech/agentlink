---
'@4thtech-io/core': patch
'@4thtech-io/types': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-PAUSE (D-143 (5)): the owner can pause an agent. Store schema version 11 adds `agent_pause` (one row while paused). `POST /api/ui/agents/pause` `{generation}` is a route kind of its own (no presence, nothing signed, only the pause row written); `POST /api/ui/agents/resume` is a presence route that signs the new local owner action `agent.resume` `{agent}` (600 s, nonce single use; refused with `not_paused` before the gesture when not paused), and core deletes the row in the same store write that records the nonce. While paused (and when the pause row cannot be read: fail closed) the sending and fetching tools answer `rejected` / `AGENT_PAUSED` before any effect and keep no idempotency result; core refuses sync, catch-up, subscriptions, sends, file fetches, terms, proofs and card updates with `agent_paused`; the outbox publishes nothing (queued rows wait); the background loop keeps the lease and idles, closing its subscription within one 5 s check; the app host's pairing passes skip the agent. `agentlink_status` and `agentlink_inbox` answer from the store, and status adds the paused line. `GET /api/ui/agents` and the events stream show `paused`. No MCP tool or CLI command pauses or resumes; the tool surface is unchanged.
