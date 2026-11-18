---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/ui': patch
'@4thtech-io/agentlink': patch
---

SEC-HARD-CEILING and SEC-OUTBOUND-CAPS (D-156): hard spending limits for proofs, $0.50 per proof and $10 in any 24 hours by default, above which a proof is refused (`SPEND_CEILING`) and never offered for approval; the "ask me" limit per proof is now $0.20 by default and is always at most the hard limit. Sending limits for what the AI sends with `agentlink_send`: 300 messages to one contact and 1 000 in all, 50 files to one contact, 200 files and 2 000 MB in any 24 hours (`SEND_LIMIT`, with when to try again). Both are on the Rules page and change only with the owner's presence; raising a hard limit goes through the spending confirmation. Rules signed before this version read as these defaults.
