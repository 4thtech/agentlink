---
section: Changed
---

- A release no longer waits 20–60 min for the Version packages commit's own CI (RELEASE-VERSION-ONLY-REUSE, S2, release-and-deployment.md §4.1): when the git trees show the commit only bumps versions, changelogs and consumed changesets, and its parent's CI and Security gates are green, `ci-green` reuses that verdict. Anything else waits for the commit's own CI as before; the owner's publish approval is unchanged.
