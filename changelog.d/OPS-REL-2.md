---
section: Changed
---

- Packages (OPS-REL-2, S2; owner decision 2026-10-18): the internal workspace packages moved from the `@agentlink` npm scope, which belongs to a third party, to `@4thtech-io/*` (for example `@4thtech-io/crypto`, `@4thtech-io/core`), and every one of them stays private; only the CLI `@4thtech-io/agentlink` publishes, unchanged. deps-check and the manifest check now refuse any package name, dependency or import in the old scope, and a repository test fails on any remaining reference outside history. Specs, docs and `AGENTS.md` use the new names.
