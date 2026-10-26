---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

The local web app's Files page (M1-11c-a3): `GET /api/ui/files` (the folders your AI can send files from, with their real locations), `GET /api/ui/files/review` (checks a folder to allow or remove against the 04 §4 rules, follows links to the real folder, and prepares the change without signing it) and `POST /api/ui/files/folders` (behind the owner presence gate: signs exactly the reviewed change). D-119: the server signs only when every warning returned for that exact change is acknowledged; the acknowledgement is bound to the change's hash and each review is used once. The read-only client view that handlers get now also has `files.resolvedFolders` and `files.preparePolicyEdit` (both write nothing). The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
