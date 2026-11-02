---
section: Changed
---

- A pull request no longer waits for a macOS runner unless it touches macOS-specific code (OPS-MACOS-QUEUE, S2, CI): the macOS legs of `keychain`, `path-guard` and `node-os` run on a pull request only for the OS keychain, KeyStore, approval and CLI keychain-test files (or a file named for macOS), and always on `main`, where the release gate still requires them. A macOS leg cancelled before any step ran is reported as "runner unavailable", and `ci-auto-retry` now also retries `path-guard` once.
