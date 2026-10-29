---
section: Fixed
---

- The release health check waits up to 15 minutes for npm to serve each new package file before it checks provenance and signatures, and a re-run of a release that failed after publishing now finishes it (moves `latest` after the check passes, then creates the GitHub Release and the desktop bundles) instead of stopping (CHORE-RELEASE-HEALTH-TARBALL-WAIT, process).
