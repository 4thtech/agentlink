# Changesets

A pull request that changes a published package adds a changeset with `pnpm changeset`
(docs/process/versioning.md, D-43). Do not bump versions by hand.

The `@agentlink/*` libraries and `@4thtech/agentlink` move together in one fixed group during beta,
listed by name in `config.json`. Only `@4thtech/agentlink` is published (OPS-REL-1): the libraries
are private and bundled into it. `privatePackages.version: true` keeps them versioned in the group,
so a changeset for a library also releases a new CLI, and a library change needs a changeset. Apps that are deployed rather than published (console, verify,
invite, cloud-agent, submitter, drop) are not in it; the desktop apps join in M2.
