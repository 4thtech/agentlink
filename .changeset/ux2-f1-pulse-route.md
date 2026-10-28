---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

The local app's server can now show how active each contact has been (UX2-f1): one read-only route, `GET /api/ui/messages/pulse`, for the owner's browser session only. Per contact it returns message counts in twelve two-hour buckets over the last 24 hours, the last exchange time and an activity word (Active now, Today or Quiet). Counts and times only: never message text, a subject, a file name or size. At most 1 000 contacts per answer, and core's new `messages.pulseTimes` reads only contact IDs and times in one bounded store read. Nothing is written and no AI tool changes.
