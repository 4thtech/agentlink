# Claude Desktop extension (optional, D-91)

An optional one-click package of AgentLink for Claude Desktop. The product stays harness-agnostic: every AI app, Claude Desktop included, can use the same `npx -y @4thtech-io/agentlink` server (06 §7). This bundle only saves Claude Desktop users the JSON config step.

## What is here

| File | Purpose |
|---|---|
| `manifest.json` | The manifest template (MCPB format, `manifest_version` 0.3, checked against the schema of `@anthropic-ai/mcpb` 2.1.2). It starts the published CLI as `agentlink mcp` and asks the user for nothing. The release build fills `version` and `compatibility.platforms`. |
| `4thtech-signing.crt` | The public 4thTech signing certificate (PEM). Present (self-signed, valid until 2029-10-22, SHA-256 fingerprint `7A:1C:DE:6D:95:E5:18:C4:79:49:62:12:FD:9A:51:25:FF:01:9A:5D:93:A9:96:3D:B9:98:8F:C5:31:47:64:6E`); releases sign bundles with it when the `DESKTOP_EXT_SIGNING_KEY` secret exists. Public material only: never put a key here. |

## How a release builds it

`release.yml` (jobs `desktop-extension-build` and `desktop-extension-release`), after a stable npm `latest` publish:

1. `tools/desktop-extension/build.mjs` installs exactly `@4thtech-io/agentlink@<version>` from npm into `server/node_modules` for each platform (`darwin-arm64`, `darwin-x64`, `win32-x64`) with that platform's native modules, without install scripts, with dependency resolution frozen at the version's publish time, and writes a reproducible zip `agentlink-<version>-<platform>.mcpb` (same version, same bytes).
2. After a green production smoke test, in environment `npm-publish`, the bundles are signed with the environment secret `DESKTOP_EXT_SIGNING_KEY` when it exists (`tools/desktop-extension/sign.sh`), checked against `4thtech-signing.crt` (`verify.sh`), listed in `SHA256SUMS`, given a build provenance attestation, and attached to the GitHub Release `v<version>`.

Build one locally (network access to the npm registry; runs no package code):

```sh
node tools/desktop-extension/build.mjs --version 0.1.2 --target darwin-arm64 --out /tmp/agentlink-ext
```

## Signature format

The MCPB signature of the reference tool `@anthropic-ai/mcpb` 2.1.2 (`mcpb sign`): a detached PKCS#7 (CMS) SignedData over the zip bytes, SHA-256, RSA, signer certificate included, signed attributes contentType, messageDigest and signingTime, appended as `MCPB_SIG_V1` + length (uint32, little-endian) + DER + `MCPB_SIG_END`. The key must be RSA: the reference signer reads keys with node-forge, which supports RSA only. Beta: a self-signed 4thTech certificate (D-91).

## Owner: create the signing key (once)

On your own machine, never in chat or in a repository:

1. `mkdir -p -m 700 ~/agentlink-signing`
2. `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ~/agentlink-signing/ext.key && chmod 600 ~/agentlink-signing/ext.key`
3. `openssl req -new -x509 -key ~/agentlink-signing/ext.key -out ~/agentlink-signing/4thtech-signing.crt -days 1095 -sha256 -subj "/O=4thTech/CN=AgentLink Desktop Extension"`
4. GitHub, repository Settings, Environments, `npm-publish`, Add environment secret: name `DESKTOP_EXT_SIGNING_KEY`, value the whole content of `ext.key` (`pbcopy < ~/agentlink-signing/ext.key`, paste, then `pbcopy < /dev/null`).
5. Back up `ext.key` offline; then delete the local copy if you do not need it.
6. Commit only `4thtech-signing.crt` to this folder (a PR). Check the fingerprint with `openssl x509 -in apps/cli/desktop-extension/4thtech-signing.crt -noout -fingerprint -sha256`.

Verify a released bundle: `gh attestation verify agentlink-<version>-<platform>.mcpb --repo 4thtech/agentlink`, `sha256sum -c SHA256SUMS`, and `bash tools/desktop-extension/verify.sh apps/cli/desktop-extension/4thtech-signing.crt agentlink-<version>-<platform>.mcpb`.
