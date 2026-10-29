---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

U3-g-c: Welcome's "Pick your AI app" lists the AI apps on a computer with no agent yet. The no-agent app host now gets the CLI's AI apps reader (the U3-f harness desk), list only (`AppHostOptions.aiAppsList`), so `GET /api/ui/apps` answers with the detected apps, entry-only, before the first agent exists. Preview, apply and disconnect still answer `409 no_agent` until first run's `finish` opens the first agent; that agent's own full desk then answers every AI apps route.
