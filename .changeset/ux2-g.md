---
'@4thtech-io/local-ui': patch
'@4thtech-io/ui': patch
---

UX2-g: Home shows a Start here card (protect approvals, invite your first contact, check the safety code, send your first message, save your recovery kit) in place of the Next step card. Each step ticks only from what the app reads (passkey state, contacts, Sent messages, the kit flag), never from a click; the count is "x of 4" for steps 1, 2, 4 and 5; step 3 is recommended and never holds the card; the card cannot be dismissed and leaves once the four are done. The Home sidebar item carries a dot until then, and the empty states on Contacts, Messages and Files point to step 2. ui: a nav item can carry a dot with its own accessible name.
