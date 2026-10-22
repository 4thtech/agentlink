---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

The local approval server can serve the local web app (D-118): an in-memory bundle of its built files under `/assets/`, its page at `/first-run` and `/settings`, and a `/api/ui/` route registry in which every change needs owner presence, checked centrally before the route runs. `/` and `/approve/<id>` keep the approval page. The CLI embeds the app's build when present.
