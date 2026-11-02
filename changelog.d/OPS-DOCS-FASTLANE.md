---
section: Changed
---

- A pull request that changes only documentation now runs a short set of quick doc checks instead of the whole test suite, so it is ready to merge in a few minutes (OPS-DOCS-FASTLANE, S2): pull requests that touch code, the user guide pages the app tests read, or CI itself still run everything.
