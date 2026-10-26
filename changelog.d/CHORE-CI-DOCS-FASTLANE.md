---
section: Changed
---

- Documentation-only changes merge faster (CHORE-CI-DOCS-FASTLANE, S1, ci-cd.md): a merge-queue group that holds only docs runs the checks for the affected packages instead of the full suite, and a docs-only push to a feature branch skips the heavy jobs. Any code change, an unknown diff base, or a push to `main` still runs everything. Pull requests that change `docs-site/` now need an independent review like other public docs, except the generated status page.
