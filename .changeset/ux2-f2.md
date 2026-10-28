---
'@4thtech-io/local-ui': patch
---

UX2-f2: Messages and Contacts rows show a 24-hour pulse and an activity word (b11 §24). The word is Active now (static filled dot), Today (hollow ring) or Quiet (no dot); the pulse is 12 bars from `GET /api/ui/messages/pulse`, one image named "14 messages in the last 24 hours". One ring plays once when a row becomes Active now, never in a loop and never under reduced motion. One read serves the whole list, every 60 seconds while the tab is visible; a failed or partial read leaves a flat pulse and no word. A Sort control (Recent, Most active) is remembered in this browser. Counts and times only: no message text is read or shown.
