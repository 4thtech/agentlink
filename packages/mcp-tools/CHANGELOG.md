# @4thtech-io/mcp-tools

## 0.4.6

### Patch Changes

- b72f9ad: W4-PAUSE (D-143 (5)): the owner can pause an agent. Store schema version 11 adds `agent_pause` (one row while paused). `POST /api/ui/agents/pause` `{generation}` is a route kind of its own (no presence, nothing signed, only the pause row written); `POST /api/ui/agents/resume` is a presence route that signs the new local owner action `agent.resume` `{agent}` (600 s, nonce single use; refused with `not_paused` before the gesture when not paused), and core deletes the row in the same store write that records the nonce. While paused (and when the pause row cannot be read: fail closed) the sending and fetching tools answer `rejected` / `AGENT_PAUSED` before any effect and keep no idempotency result; core refuses sync, catch-up, subscriptions, sends, file fetches, terms, proofs and card updates with `agent_paused`; the outbox publishes nothing (queued rows wait); the background loop keeps the lease and idles, closing its subscription within one 5 s check; the app host's pairing passes skip the agent. `agentlink_status` and `agentlink_inbox` answer from the store, and status adds the paused line. `GET /api/ui/agents` and the events stream show `paused`. No MCP tool or CLI command pauses or resumes; the tool surface is unchanged.
- Updated dependencies [b72f9ad]
- Updated dependencies [b72f9ad]
- Updated dependencies [b72f9ad]
- Updated dependencies [b72f9ad]
  - @4thtech-io/types@0.4.6
  - @4thtech-io/core@0.4.6
  - @4thtech-io/log@0.4.6
  - @4thtech-io/chain@0.4.6
  - @4thtech-io/crypto@0.4.6

## 0.4.5

### Patch Changes

- @4thtech-io/chain@0.4.5
  - @4thtech-io/core@0.4.5
  - @4thtech-io/crypto@0.4.5
  - @4thtech-io/log@0.4.5
  - @4thtech-io/types@0.4.5

## 0.4.4

### Patch Changes

- Updated dependencies [c3e523c]
- Updated dependencies [6d5b6aa]
- Updated dependencies [0af8fb0]
- Updated dependencies [0a54944]
- Updated dependencies [3307e7d]
- Updated dependencies [e469067]
- Updated dependencies [5901726]
- Updated dependencies [276b400]
- Updated dependencies [4802f9a]
- Updated dependencies [b2f3aa0]
  - @4thtech-io/types@0.4.4
  - @4thtech-io/core@0.4.4
  - @4thtech-io/crypto@0.4.4
  - @4thtech-io/chain@0.4.4
  - @4thtech-io/log@0.4.4

## 0.4.3

### Patch Changes

- 64d9338: UX2-d1: the local app's API can create an invite (`POST /api/ui/invites`) and check a pasted one (`POST /api/ui/invites/check`) with no owner presence, as a new named route kind `invite` (owner decision 1.1; session, CSRF, Origin and fetch-metadata gate; create limited to 10 per 10 minutes), and accept one (`POST /api/ui/invites/accept`) behind owner presence, which signs the `contacts.acceptInvites` approval before core pairs. The accept approval action, its summary and the invite share text move to core, so the MCP tool, the CLI and the app build the same action and text; `@4thtech-io/mcp-tools/accept-action.js` re-exports them. One core summary, `acceptInviteSummary` (name, label and short owner fingerprint, 04 §3.6 Accept step 2), is used by the MCP tool, `agentlink accept` and the app, and check refuses any invite the accept input cannot carry.
- Updated dependencies [64d9338]
- Updated dependencies [29660b0]
  - @4thtech-io/core@0.4.3
  - @4thtech-io/chain@0.4.3
  - @4thtech-io/crypto@0.4.3
  - @4thtech-io/log@0.4.3
  - @4thtech-io/types@0.4.3

## 0.4.2

### Patch Changes

- @4thtech-io/chain@0.4.2
  - @4thtech-io/core@0.4.2
  - @4thtech-io/crypto@0.4.2
  - @4thtech-io/log@0.4.2
  - @4thtech-io/types@0.4.2

## 0.4.1

### Patch Changes

- @4thtech-io/chain@0.4.1
  - @4thtech-io/core@0.4.1
  - @4thtech-io/crypto@0.4.1
  - @4thtech-io/log@0.4.1
  - @4thtech-io/types@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [662785b]
- Updated dependencies [64dab44]
- Updated dependencies [f4d0c03]
- Updated dependencies [c5425de]
- Updated dependencies [a6846b5]
  - @4thtech-io/crypto@0.4.0
  - @4thtech-io/core@0.4.0
  - @4thtech-io/chain@0.4.0
  - @4thtech-io/log@0.4.0
  - @4thtech-io/types@0.4.0

## 0.3.0

### Patch Changes

- cb39547: M2-3t: the MCP tool handlers move into their own package, `@4thtech-io/mcp-tools`. No change to the tools, their names, descriptions or schemas.
- Updated dependencies [639f174]
- Updated dependencies [b3b8782]
- Updated dependencies [f1cff39]
  - @4thtech-io/core@0.3.0
  - @4thtech-io/types@0.3.0
  - @4thtech-io/chain@0.3.0
  - @4thtech-io/crypto@0.3.0
  - @4thtech-io/log@0.3.0
