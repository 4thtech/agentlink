# Under the hood

<!-- ai-knowledge: summary
summary: The way into the specifications: what each spec covers, which technical page explains it in shorter words, reading order for engineers and why two specs are not public. -->

> **Status: Current for v0.5.10.** The way into the specifications. It says what each spec covers, which page here explains it in shorter words, and in what order to read them.

AgentLink is specified in [`specs/`](https://github.com/4thtech/agentlink/tree/main/specs). Those files are **normative**: code, tests and these pages follow them, and where this site and a spec disagree, the spec wins. A spec changes only together with a recorded decision in the [decision log](https://github.com/4thtech/agentlink/blob/main/specs/decisions/README.md) (one file per decision, D-1 to D-156).

The pages on this site are the **explanation layer**: shorter, current for the release they name, and checked in CI against the specs where it matters most (every threat in 04 §7 appears in the [threat model](threat-model.md); every decided security decision is explained on a security page).

## How to read a spec

- A reference such as **04 §2.5** means section 2.5 of spec 04. Every numbered heading is a GitHub anchor: `04-security-and-crypto.md#25-owner-operations-and-user-presence`.
- The large specs (04, 06, 07, 08, 11) are written to be searched, not read end to end. List the sections first: `grep -n '^#' specs/04-security-and-crypto.md`, then open the range you need.
- Words: see the [glossary](glossary.md). The app calls a harness an "AI app" and an agent identity an "ID".

## Why 01 and 09 are missing

The numbering has two gaps on purpose. **01 (commercial brief)** and **09 (repositories and reuse)** hold business planning and an audit of older internal code; they live in a private 4thTech repository (decisions D-21 and D-26). Nothing in them is needed to build, review or verify AgentLink, and nothing in the public specs refers to them for a rule. The OCC v2 contract source is private until mainnet too (D-19); its behaviour is fully specified in 05, and the public repo consumes only the ABI and the shared test vectors.

## Reading order for engineers

| Step | Read | Why |
|---|---|---|
| 1 | [Architecture](architecture.md), then [03](https://github.com/4thtech/agentlink/blob/main/specs/03-architecture.md) §1, §2, §5 | Components and trust boundaries |
| 2 | [Security model](security-model.md), then [04](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md) §1 (invariants) and §2.5 (owner presence) | The rules no change may break |
| 3 | [Envelopes and encryption](envelopes.md), then 04 §3 | What every message is |
| 4 | The spec of the part you work on (table below) | The exact behaviour |
| 5 | [Threat model](threat-model.md) and 04 §7 | What each mechanism defends against |
| 6 | [Status and roadmap](../project/status-and-roadmap.md) and [10](https://github.com/4thtech/agentlink/blob/main/specs/10-build-plan.md) | What is built and what comes next |

Security reviewers: steps 2, 3 and 5, then [Crypto suites](../reference/crypto-suites.md), [Policies](../reference/policies.md) and [Test vectors](../reference/test-vectors.md). Verifiers: [Records, receipts and proof packs](proof.md), 07 §8 and [Verify a proof independently](../guides/verify-a-proof.md).

## Spec map

| Spec | Key sections | Explained on |
|---|---|---|
| [00 README](https://github.com/4thtech/agentlink/blob/main/specs/00-README.md) | Reading order, core principles, invariants pointer, glossary; the [decision log](https://github.com/4thtech/agentlink/blob/main/specs/decisions/README.md) | [Project overview and principles](../project/overview-and-principles.md), [Design decisions](design-decisions.md), [Glossary](glossary.md) |
| 01 commercial brief | Private (D-21, D-26) | — |
| [02 Product spec](https://github.com/4thtech/agentlink/blob/main/specs/02-product-spec.md) | §3 features (F-xx), §4 free vs paid, §5 journeys, §6 non-goals | [Project overview and principles](../project/overview-and-principles.md), [Status and roadmap](../project/status-and-roadmap.md) |
| [03 Architecture](https://github.com/4thtech/agentlink/blob/main/specs/03-architecture.md) | §2 components, §3 packagings, §4 data flows, §5 trust boundaries, §7 chains | [Architecture](architecture.md), [Transport](transport.md) |
| [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md) | §1 invariants; §2 keys (§2.3 passkey and recovery kit, §2.5 owner presence, §2.5.4 start over, §2.8 file KeyStore); §3 envelope (§3.1.1 signatures and the typed-data allowlist, §3.4 payloads and `ack`, §3.6 pairing and safety code); §4 files (§4.1 auto-save, §4.2 retention); §5 on-chain records (§5.1 proof privacy); §6 forward secrecy; §7 threat model; §8 engineering rules | [Security model](security-model.md), [Threat model](threat-model.md), [Identities and keys](identities-and-keys.md), [Envelopes and encryption](envelopes.md), [Files](files.md), [Privacy of proofs](privacy.md), [Crypto suites](../reference/crypto-suites.md) |
| [05 Contracts OCC v2](https://github.com/4thtech/agentlink/blob/main/specs/05-contracts-occ-v2.md) | §2 `OCCFeeVault`, §3 `OCCNotary`, §4 `OCCRegistry`, §5 roles and governance, §9 deployment | [Contracts](../reference/contracts.md), [Networks and contract addresses](../reference/networks-and-contracts.md), [Payments, credits and trust](payments-credits-and-trust.md) |
| [06 MCP server](https://github.com/4thtech/agentlink/blob/main/specs/06-mcp-server.md) | §1 design rules, §2 tools, §3 policies, §4 untrusted content format, §7 harness installation, §8 CLI | [MCP tools](../reference/mcp-tools.md), [Policies](../reference/policies.md), [Harness configuration](../reference/harness-configuration.md), [CLI](../reference/cli.md) |
| [07 SDK, transport, storage](https://github.com/4thtech/agentlink/blob/main/specs/07-sdk-transport-storage.md) | §1 packages, §3 local store, §4 transport, §5 storage and the drop, §6 chain, §7 submitter, §8 proof pack, §9 KeyStore backends | [SDK packages](../reference/sdk-packages.md), [Transport](transport.md), [Files](files.md), [Proof pack format](../reference/proof-pack-format.md), [Records, receipts and proof packs](proof.md) |
| [08 Clients, console, cloud](https://github.com/4thtech/agentlink/blob/main/specs/08-clients-console-cloud.md) | §1 local app (approvals, files, widget reads), §3 cloud agent, §4 public pages, §8 desktop apps (shell, updates, menu bar widget) | [Security model](security-model.md), [Self-host the cloud agent](../guides/self-host-cloud-agent.md) |
| 09 repositories and reuse | Private (D-21, D-26) | — |
| [10 Build plan](https://github.com/4thtech/agentlink/blob/main/specs/10-build-plan.md) | Milestones M0 to M6, working rules | [Status and roadmap](../project/status-and-roadmap.md), [Versioning and changelog](../project/versioning.md) |
| [11 Design brief](https://github.com/4thtech/agentlink/blob/main/specs/11-claude-design-brief.md) | §4 UX principles, §5 vocabulary and microcopy, §6 surfaces, §10 trust and security UX | [Contributing](../project/contributing.md) (copy rules), the [user guide](https://github.com/4thtech/agentlink/blob/main/docs/guide/README.md) |
| [12 Economics and fees](https://github.com/4thtech/agentlink/blob/main/specs/12-economics-and-fees.md) | §2 fee schedule, §3 fee tokens, §4 how a fee is charged, §6 changing prices | [Payments, credits and trust](payments-credits-and-trust.md) |

## Keeping this layer true

A change that touches security-relevant code or 04 also updates the matching page here (security model, threat model, policies, MCP tools, privacy) or says in its pull request why none applies (`security-docs: none (<reason>)`). `tools/check-security-docs.mjs` runs in CI: it checks that every 04 §7 threat is on the [threat model](threat-model.md), that every decided decision citing 04 is referenced on a security page or allowlisted with a reason, that pages about shipped features carry no design-only or upcoming-release labels, that release stamps are not older than the current minor version, and that every "NN §x.y" reference on these pages names a real section.
