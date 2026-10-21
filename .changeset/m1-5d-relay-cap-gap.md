---
'@4thtech-io/transport-nostr': patch
---

Sync now reports a second that a relay may hold more messages in than it returns (a gap with the fixed reason `relay_cap`), instead of stepping past it without a word (M1-5d).
