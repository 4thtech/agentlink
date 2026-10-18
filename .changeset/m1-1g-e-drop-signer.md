---
'@4thtech-io/crypto': patch
'@4thtech-io/node': patch
---

M1-1g-e: `KeyStore.signDropRequest(request, createdAt)` signs one encrypted-drop request with the agent's separate drop key at the current epoch and returns the `Authorization` header (07 §5.4). It is the `DropSigner` the drop adapter takes. The KeyStore fixes the event kind (27235) and the `domain` tag, signs only POST and DELETE to an https URL in serialised form over the drop's signed JSON body with `createdAt` equal to its `ts`, and refuses anything else with one fixed error before reading any key. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestSnapshot` and `DROP_REQUEST_REFUSED` are in the main entry; the raw-key `signDropRequest` is in the restricted `@4thtech-io/crypto/keystore` entry.
