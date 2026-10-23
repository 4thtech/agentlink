---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

The local web app's Rules page (M1-11c-a5): `GET /api/ui/rules` (the rules in force as the page shows them: values and counts, no agent IDs, folder paths or proof network), `GET /api/ui/rules/review?edit=` (core's `preparePolicyEdit` for an edit of the page's own fields; answers the prepared body's SHA-256 and its warning codes) and `POST /api/ui/rules` behind the central presence gate. D-119: the server signs only a body it prepared, named by its hash, once and before it expires, and only when the owner acknowledged exactly that body's warning codes; otherwise it signs nothing and the gate answers 409 `refused`. The read-only client view that handlers get now also has `policy.load`, `policy.prepareEdit` and `policy.recordReceiptsKept`.
