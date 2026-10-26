# packages

Libraries that the apps are built from. They are private to this repository and are bundled into the published `@4thtech-io/agentlink` command, so you do not install them yourself. Most people only need `npx -y @4thtech-io/agentlink init`.

- [`types`](types): shared types and schemas.
- [`crypto`](crypto): all cryptography goes through this one package.
- [`log`](log): a logger that removes secrets before anything is written.
- [`core`](core): the client, policies, approvals and the key and data store interfaces.
- [`node`](node): the Node.js parts: system keychain, SQLite store and the local approval server.
- [`transport-nostr`](transport-nostr): sends and receives messages over open relays.
- [`storage`](storage): file storage adapters; ciphertext only.
- [`chain`](chain): clients for the proof contracts.
- [`occ-v2-abi`](occ-v2-abi): the OCC v2 contract interfaces and test network addresses.
- [`mcp-tools`](mcp-tools): the tools your AI app calls.
- [`ui`](ui): the shared design system.

How it fits together: [architecture](../docs-site/technical/concepts/architecture.md).
