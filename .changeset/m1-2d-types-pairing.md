---
'@agentlink/types': minor
---

Pairing bodies carry the safety-code fields: the invite adds `cardAgentSig` and `codeCommit`, the `handshake` adds `cardAgentSig`, `codeNonce`, `codeCommit` and `inviterCardHash`, and the `handshake-ack` adds `handshakeHash`, `codeReveal`, the inviter's `card` and `cardSig`, and its `relays`. All are required. A relay list carried with a card now needs 2 to 16 relays.
