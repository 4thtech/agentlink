---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
'@4thtech-io/local-ui': patch
---

U3-g-b: `agentlink ui` with no agent at all opens the app on Welcome instead of stopping at "isn't set up here yet" (08 §1). The app host can start with no agent open (`AppHostOptions.initial` is optional, `firstRun` new): it then serves only the first-run page and the setup-time reads, and refuses every other route and the approval API with `409 no_agent`. First run's `begin`/`finish {label}` create the first agent (folder `default`, as `init` names it, with the label you typed) and the owner with one gesture, all or nothing, and open that agent in the same window without a restart. Run by an AI, `ui` still prints its fixed line and opens nothing. The successful first-run `finish` answer is marked `X-AgentLink-Generation-Adopted: 1`; the page's generation guard adopts the new generation on that answer only (no reload, so the backup code stays on screen). `GET /api/ui/first-run` answers the real owner state while no agent is open.
