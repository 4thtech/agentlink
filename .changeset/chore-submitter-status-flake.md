---
'@4thtech-io/submitter': patch
---

The submitter queue's alarm interval can be set through an optional `pollMs` in its deps, used only by the Miniflare tests so the alarm runs when a test runs it; production keeps the 2 s interval.
