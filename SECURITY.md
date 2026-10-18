# Security policy

AgentLink is software for encrypted, provable exchange between AI agents. We take reports about it seriously.

## Reporting a vulnerability

Report vulnerabilities **only** through GitHub private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker gains.

Direct link: <https://github.com/4thtech/agentlink/security/advisories/new>

**Do not** open a public issue, pull request or discussion for a suspected vulnerability, and do not post details in chat or social media before a fix is available.

Please do not include live secrets, real private keys, real user data or production credentials in a report. Use test data. If you accidentally obtained someone's secrets or content while testing, stop, tell us in the report, and do not keep or share them.

## Scope

In scope:

- Everything in this repository: the packages (`@4thtech-io/*`), the CLI and MCP server, the owner console, verify and invite pages, the cloud agent template and the submitter.
- The OCC v2 smart contracts. They are developed in a separate repository, but they are in scope and are reported the same way: through this repository's private vulnerability reporting.
- Weaknesses that break the project's security invariants, in particular: private keys or plaintext reaching any 4thTech service, relay or log; owner approvals, policies or key export being possible without owner presence; inbound agent content being treated as instructions; SSRF or path traversal in file handling; replay or forgery of signed records or receipts.

Out of scope:

- Vulnerabilities in third-party services we do not operate (Nostr relays, storage providers, blockchain RPC providers, harness applications) and in third-party dependencies. Please report those upstream; tell us as well if AgentLink is affected in a way a patch or configuration change can address.
- Social engineering, physical attacks, and denial-of-service through volumetric traffic.
- Findings that need an already compromised device, a malicious operating-system user with the owner's passkey or passphrase, or other access the threat model already assumes the attacker lacks.

The threat model and invariants are documented in `docs/foundation/04-security-and-crypto.md`.

## What to expect

| Step | Target |
|---|---|
| Acknowledge your report | within 3 business days |
| Initial triage (severity and next steps) | within 7 days |
| Fix and coordinated disclosure | agreed with you; we aim to be quick for high-severity issues |

We will keep you informed, credit you in the advisory if you wish, and publish a GitHub Security Advisory once a fix is available. We ask for a reasonable period to fix the issue before public disclosure.

## Supported versions

AgentLink is pre-release. Only the latest commit on `main` and the latest published version of each package receive security fixes.

## Bug bounty

There is no bug bounty programme yet. One is planned after the mainnet launch. Reports are appreciated and will be credited in the meantime.

## Safe harbour

If you make a good-faith effort to follow this policy, test only against your own accounts and deployments or with test data, avoid privacy violations and service disruption, and give us a reasonable chance to fix the issue before disclosing it, we will not pursue legal action against you for your research and will work with you to understand and resolve the issue.
