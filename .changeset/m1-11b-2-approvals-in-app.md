---
'@4thtech-io/node': patch
---

M1-11b-2: with the local app bundled, the approval server serves the app for `/` and `/approve/<id>` too, so Approvals and one request render inside the app (its sidebar, status bar and paid-action sheet). The session, CSRF, Origin, fetch-metadata and presence checks and the approval decision logic are unchanged; without the bundle the server-rendered approval page stays.
