---
'@4thtech-io/node': patch
---

PRE-031-FIXES: the paid approval card says "This costs credits. Approve it on its own." without an amount of its own, so it can never differ from the signed amount the confirmation sheet shows; a passkey registration body with bytes after its optional fifth field (the creation authenticator data) is refused explicitly (`presence_required`).
