# Contributing to AgentLink

Thank you for your interest. AgentLink is built in public, and this page explains how to take part. By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project stage

AgentLink is **pre-alpha** (M0 Foundations): the specifications, process and CI exist, and product code does not yet. That shapes how you can help right now:

- **Open now:** [issues](https://github.com/4thtech/agentlink/issues) for feedback, questions, ideas, and reports of unclear or inconsistent spec text. Reading and challenging the [specs](docs/foundation/00-README.md) is genuinely useful.
- **Opens after the M1a skeleton lands:** code contributions. Until then, please open an issue before investing time in a pull request, so we can tell you whether it fits the plan.

See the Status and Roadmap in the [README](README.md) for where things stand.

## How work is organised

- **Task IDs.** Every piece of work has a task card in [`docs/process/backlog.md`](docs/process/backlog.md), for example `M1-5`. No task ID, no work.
- **One task = one branch = one PR.** Put the task ID in the branch name and the PR title (`M1-5 transport-nostr sync`). Other allowed prefixes are `OPS-<n>`, `DOCS`, `CHORE` and `DEPS`.
- **Specs come first.** The documents in [`docs/foundation/`](docs/foundation/00-README.md) are the source of truth, and the invariants in [`04-security-and-crypto.md`](docs/foundation/04-security-and-crypto.md) are non-negotiable. An interface change updates the spec in the same PR (or earlier). The [documentation map](docs/README.md) shows where everything is.
- **The PR template is enforced.** Fill in every section of [`.github/pull_request_template.md`](.github/pull_request_template.md). The `pr-hygiene` and `review-gate` checks fail the PR if sections are empty or the declared security class is lower than the one derived from the changed files.
- **Security classes** decide how much review a change needs ([`audit-rules.md`](docs/process/audit-rules.md) has the full rules and path defaults):

  | Class | What it covers | Review needed, on top of the CI gates |
  |---|---|---|
  | **S0** | No security-relevant behaviour (most docs, tooling without secrets) | None beyond CI |
  | **S1** | Sensitive: inbound content, files and URLs, storage credentials, approval UI, CI configuration, specs | Independent review session; a regression test for every fix |
  | **S2** | Critical: crypto, keys, owner presence, envelope and pairing protocol, policy engine, anything that signs | Everything in S1, plus tests written first, a full threat note, and a GitHub approval by a code owner who is not the author |

- **Merging.** Merges go through GitHub auto-merge behind the required checks. Nobody pushes to `main`, and there is no admin bypass.
- **Tests and checks.** Tests are expected with every change; crypto, the policy engine and anything that signs are tests-first. The commands are in [`docs/process/repo-reference.md`](docs/process/repo-reference.md) and will be usable once the first packages land.
- **AI agents working in this repository follow [`AGENTS.md`](AGENTS.md).** Much of the project is built by orchestrated AI agents under human review, and the rules for agents and people are the same. Do not add AI-attribution lines (co-author trailers, "generated with" footers) to commits or PRs.

The full process is in [`docs/process/development-process.md`](docs/process/development-process.md).

## Versioning and the changelog

AgentLink uses SemVer, with one shared product version during beta. You do not bump versions by hand.

- A PR that changes a published package adds a **changeset**.
- A user-visible, spec or process change adds a line under `[Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).

Details are in [`docs/process/versioning.md`](docs/process/versioning.md).

## Reporting security issues

Report vulnerabilities **privately**, through GitHub private vulnerability reporting, as described in [`SECURITY.md`](SECURITY.md). Do not open a public issue, PR or discussion for them, and never include live secrets or real user data in any report.

## Licence

The software in this repository is licensed under the [MIT licence](LICENSE), and by contributing you agree that your contribution is licensed under the same terms.

The OCC v2 smart contracts live in a separate repository, which is private during the beta. Verified source is planned to be published at mainnet. Please do not submit contract source here.

## Questions

Open an [issue](https://github.com/4thtech/agentlink/issues) and say what you are trying to do. For conduct concerns, see the [Code of Conduct](CODE_OF_CONDUCT.md).
