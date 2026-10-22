---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

The local web app's Proofs and credits page (M1-11c-a4): two read routes, `GET /api/ui/proofs` (your proofs, newest first, paged) and `GET /api/ui/proofs/credits` (proofs left and the dollar balance), and the page itself. The read-only client view that handlers get now also has `proofs.list` and `proofs.creditsBalance`. No network, token, address or ID leaves the server for this page; Add credits stays hidden until the pay page is live.
