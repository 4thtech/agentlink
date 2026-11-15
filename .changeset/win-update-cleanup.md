---
'@4thtech-io/desktop': patch
---

WIN-UPDATE-CLEANUP: after a good Windows update the helper retries removing the old copy for up to 30 s with backoff (a file in it can stay in use for a moment after its process ended, for example while antivirus scans it), and the next healthy start removes a copy a finished helper left, instead of waiting 24 h for its staging folder to be swept. The update itself never waits on this.
