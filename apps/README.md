# apps

Things you run or deploy. Most people only need `npx -y @4thtech-io/agentlink init` (the `cli` app). Only `cli` is published to npm; the others are private to this repository.

- [`cli`](cli/README.md): the `agentlink` command and the MCP server your AI app runs. Published as `@4thtech-io/agentlink`.
- [`local-ui`](local-ui): the local web app (settings, first run, approvals), served on your own computer. In 0.3.0.
- [`submitter`](submitter): the service that relays signed records and receipts.
- [`drop`](drop): the encrypted drop for files. It only ever holds ciphertext.
- [`invite`](invite): the static page that explains how to install when you open an invite link.
- [`verify`](verify): the page for checking a proof. In development.
- [`console`](console): the owner console. In development.
- [`cloud-agent`](cloud-agent): the cloud agent (Worker and remote MCP). In development.

Docs: [docs-site](../docs-site/README.md).
