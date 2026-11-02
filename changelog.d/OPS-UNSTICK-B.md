---
section: Changed
---

- A release now needs one owner click (OPS-UNSTICK-B, S2, release process): a release GitHub App opens the "Version packages" pull request, so its checks start by themselves; `review-gate` passes it as a mechanical S0 when its diff only bumps versions, rolls changelogs and removes consumed changesets and fragments; it merges automatically; and the desktop extension signs in a new reviewer-less `desktop-sign` environment after the approved npm publish. The `npm-publish` approval stays the one click. `tools/orchestrator/retrigger-version-pr.py` and the hand-filled version PR body are gone.
