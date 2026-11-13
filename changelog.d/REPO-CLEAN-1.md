### Added

- The npm package includes THIRD-PARTY-NOTICES.md: the licences of React, react-dom, scheduler, qrcode-generator, the Geist fonts and the Lucide-derived icons inside the built-in app, generated from the installed packages at build time (REPO-CLEAN-1).

### Changed

- CONTRIBUTING.md describes the project as it is today (pre-alpha, working on test networks), `pnpm verify`, `tools/pr/open-pr.mjs` and `changelog.d/` fragments (REPO-CLEAN-1).
- User-guide pages checked against 0.5.1 now say "Applies to AgentLink 0.5.1" (REPO-CLEAN-1).
- The desktop app's knowledge page describes Settings › Updates (Check for updates, Download update) (REPO-CLEAN-1).

### Fixed

- Two flaky tests are fixed and the test quarantine is empty again: the first-run browser test listens for the page's requests before the page loads, and the version 10 to 11 store migration test runs one case per file (REPO-CLEAN-1).
- The Messages guide page links to current source files (REPO-CLEAN-1).
