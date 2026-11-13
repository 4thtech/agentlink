---
'@4thtech-io/desktop': patch
---

CI-823: the Mac update check reads the new app's Info.plist through one handle opened without following links (type and size from that same handle), so the file cannot change between the check and the read.
