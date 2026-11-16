---
'@4thtech-io/local-ui': patch
---

HEALTH-BAR-STUCK: the status bar no longer stays on "Checking…" after the computer goes offline and back (sleep and wake, a Wi-Fi change). The app reads its health again at once and shows Connected, or Not running after 4 s with no answer; a window that opens while offline shows Not connected.
