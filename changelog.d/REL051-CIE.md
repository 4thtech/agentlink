---
section: Changed
---

- Scope change for 0.5.1 (REL051-CIE): the Windows desktop app is not part of this release. Its core stops at start on Windows and the very first start loses the one-copy check; both are being fixed separately. On Windows, use the browser app (one command), which is unaffected. The release attaches only the two Mac apps (`AgentLink-<version>-mac-arm64.dmg`, `AgentLink-<version>-mac-x64.dmg`) and `SHA256SUMS-desktop-app.txt`. The Windows build runs only when started by hand (`desktop.yml`, `windows: true`), not on pull requests or in the release; this narrows what ships, it does not weaken a check.
