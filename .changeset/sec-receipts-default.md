---
'@4thtech-io/types': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-RECEIPTS-DEFAULT (D-156): the signed "received" receipt to active contacts is on by default, under the owner's new rule `receipts.sendReceived` ("Send received receipts", absent reads as on). The receipt now names the message's content hash as well as its ID; the sender shows "Received by <name>'s app" only for that kind, shows an older app's receipt as "Received (older app)", and never shows a message sent with proof as delivered without it. A key the contact never held is not accepted. A sender's proof file can carry the contact's receipt as an "automatic device receipt", checked apart from public receipts; the owner can leave it out.
