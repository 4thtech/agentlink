---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

HOTFIX-045-TOUCHID: `GET /api/owner/passkey` answers from the owner store with no agent open in the app host (it was refused with `409 no_agent`, so every presence sheet fell back to the backup code). When the passkey can't be used the answer carries a fixed `reason` (`not_set_up_here` or `other_owner`); the local app's presence sheet says why in plain words and, for an owner without a passkey on this computer, offers a one-time "Switch to Touch ID" inside the sheet (the existing `POST /api/owner/passkey` registration; the operation is then confirmed with its own gesture). Registering still needs an open agent; every route gate is unchanged.
