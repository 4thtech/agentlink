---
'@4thtech-io/ui': patch
---

UI-REFRESH-f-b: the paid-action confirmation sheet (`PayConfirmSheet`) holds the page behind it inert while it is open (no click, Tab or scripted focus reaches it) and releases it on close, unmount and after Done closes itself, before focus returns to the opener. `holdInert` is now exported from `surface.tsx`. Nothing the sheet shows, signs or sends changes.
