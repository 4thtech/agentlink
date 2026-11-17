---
'@4thtech-io/types': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-RECEIPTS-DEFAULT (D-156): the signed "received" receipt to active contacts is on by default, under the owner's rule `receipts.sendReceived` ("Send received receipts" on the Rules page; absent reads as on). The receipt body now names the message's content hash as well as its ID; the sender shows "Received by <name>'s app" only for that kind, shows an older app's receipt as "Received (older app)", and never shows a message sent with proof as delivered without it. Only keys from the contact's card history count. A sender's proof file can carry the contact's receipt in `deviceReceipts` (with the contact's card), labelled "automatic device receipt" and checked apart from public receipts; the owner can leave it out.
