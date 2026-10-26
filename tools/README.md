# tools

Scripts that keep the repository healthy. They are for maintainers and CI, not for users.

- [`ci`](ci): CI helpers (affected-package selection, retries, keyring setup).
- [`deps-check`](deps-check): enforces which package may import which.
- [`docs-status`](docs-status): generates the status blocks in the README and docs from `docs/status.yaml`.
- [`release`](release): changelog, changeset and deploy checks.
- [`vectors`](vectors): generates and checks the shared test vectors.
- [`unicode`](unicode): Unicode table checks.
- [`occ-v2-abi`](occ-v2-abi): imports and verifies the contract interfaces.
- [`relays`](relays): checks the default relay list.
- [`sync-pin-check`](sync-pin-check): checks that the secret-scan pin on the team sync branch is current.
- [`desktop-extension`](desktop-extension): builds and signs the Claude Desktop extension.
- [`dogfood`](dogfood): helpers for the two-person dogfood run.
- [`orchestrator`](orchestrator): helpers for the people and agents running the project.

The `check-*.mjs` files at this level are repository checks that CI runs. See [repo reference](../docs/process/repo-reference.md).
