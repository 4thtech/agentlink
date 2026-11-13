---
section: Changed
---

- The Mac download links no longer change with each release: README, the docs, the knowledge files, llms.txt and the invite page link to `AgentLink-mac-arm64.dmg` and `AgentLink-mac-x64.dmg` on the latest release. The release adds those two files and marks itself Latest only after the app is attached and checked, then checks both links (REL-LINKS-1, REL-LINKS-2, REL-LINKS-3, REL-LINKS-4, S2: release workflow; a drift check fails on a versioned download link).
- A release can be held: while the repository variable `RELEASE_HOLD` is `true`, the Version packages PR keeps collecting changes but is not merged automatically and nothing is published until the owner ships it (REL-HOLD-1).
