# Changesets

A pull request that changes a published package adds a changeset with `pnpm changeset`
(docs/process/versioning.md, D-43). Do not bump versions by hand.

The `@agentlink/*` libraries and `@4thtech/agentlink` move together in one fixed group during beta,
listed by name in `config.json`. Apps that are deployed rather than published (console, verify,
invite, cloud-agent, submitter, drop) are not in it; the desktop apps join in M2.
