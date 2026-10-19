---
'@4thtech-io/crypto': patch
'@4thtech-io/node': patch
'@4thtech-io/types': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
---

M1-4d-d-b: the agent card's proof of possession (04 §2.9, D-102). `TAGS.cardPop` (`agentlink/card-pop/v1`), `verifyCardPop`, `verifyCardPossession` and `cardPopSnapshot` are in the crypto main entry; the raw-key `signCardPop` is in the restricted `@4thtech-io/crypto/keystore` entry. `KeyStore.signCardPop(card)` signs only the store's own card at its current key epoch and refuses anything else with one fixed error; implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). The `handshake` and `handshake-ack` bodies take an optional `cardPop`, and `card-update` optional `cardAgentSig` and `cardPop`, together or not at all. The core makes `cardPop` with every own card (init, so also `owner add-agent`, and rotation once the KeyStore is at the new epoch; a card stored before this change gets one on first use), sends it in `handshake` and `handshake-ack`, verifies a received pair in `handshake`, `handshake-ack` and `card-update` (a present signature that does not verify drops the whole body), and stores a contact's verified pair. `proofSigner(from)` returns the signer block with the pair for the upcoming `exportProofPack` (M1-7g); the core does not yet send `card-update` itself. `verifyProofPack` uses the crypto check instead of its own composition (no behaviour change).
