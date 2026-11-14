---
'@4thtech-io/desktop': patch
---

WIN-INAPP-UPDATE: the Windows app updates itself from Settings › Updates (Update now, then Restart now), on the same signed update document as the Mac app. The app downloads the Windows setup, checks its size and SHA-256 against the signed document, and after Restart now a small helper waits for the app to close, moves the old copy aside, runs the setup silently, starts the new version and keeps the old one if anything fails. The release's update document now lists the Windows setup. The setup upgrades silently in place and never skips a file it cannot write.
