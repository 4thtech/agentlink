---
'@4thtech-io/node': patch
'@4thtech-io/ui': patch
---

M1-11b-2c: the server-rendered approval page is removed. `/app.js` and `/app.css` are gone (404); Approvals live only in the local app, which the approval server serves on `/` and `/approve/<id>`. A server without the app bundle answers those two with a fixed page (503, no script, no CSRF token) that points to `approve` in the owner's own terminal. The session, CSRF, Origin, fetch-metadata and presence checks and the approval decision logic are unchanged. `@4thtech-io/ui`: a comment in the confirmation sheet no longer points to the removed page.
