# Desktop build tooling (WP-D4)

First-party scripts, no packager. Run on the matching OS: `build-mac.mjs` (macOS), `build-win.mjs` (Windows; `--nsi-only` anywhere).

- Pins: `constants.json` (Node and Electron versions, per-asset SHA-256). Fetch is plain HTTPS, every redirect hop checked against the host list, size cap and timeout, hash check before use.
- Signing is ad-hoc on our bundle, Electron frameworks and helpers only. `Resources/node` keeps its upstream Node.js signature (re-signing it would prompt for every existing keychain item). Developer ID is a hook that stays off (`DESKTOP_SIGNING=on`).
- Owner-presence helper (macOS): `native.mjs` builds it as an app bundle, `AgentLink.app` (fixed identifier `io.4thtech.agentlink.presence`, Info.plist from `native/macos/Info.plist`, the icon from `assets/AgentLink.icns`, no Dock icon), so the Touch ID sheet shows the AgentLink name and icon. `build-mac.mjs` puts it at `Contents/Helpers/AgentLink.app` (or takes a prebuilt one with `--helper <AgentLink.app>`), checks its identity and a strict signature verify after signing, and records the SHA-256 of its executable, Info.plist and icon in `inputs-*.json`.
- Hashes (`lib/hash.mjs`) go through `@4thtech-io/crypto`, like every other hash in the repository. Test files here are `*.test.mjs` run by `node --test` (allowed in exactly these test folders: `tools/deps-check/policy.mjs` `NODE_TEST_DIRS`).
- The DMG carries `assets/dmg/read-me-first.txt` as "Read me first.txt": the first-open steps for an unsigned build.
- CI checks on the built binaries: `check-fuses.mjs` (fuses and ASAR integrity, all slots), `check-preview-string.mjs`, `check-switch-lockdown.mjs`, `check-tampered-asar.mjs`.

## What the ASAR integrity does and does not cover

The integrity fuse covers `app.asar` only (the shell's JavaScript). `Resources/core` (the CLI bundle and its `node_modules`) and `Resources/node` sit **outside** it. They are protected by:

1. A committed lock, `core-lock/package-lock.json`, for the CLI's production dependencies. The build runs `npm ci --ignore-scripts` from it against `registry.npmjs.org` only (integrity hashes checked), then unpacks the packed CLI tarball, whose dependencies must be a subset of the lock. No transitive package is resolved at build time. It is derived from pnpm-lock.yaml (`update-core-lock.mjs`, no network), so it carries the same name@version and integrity as the repository lock; a test fails on drift.
2. No install script may exist in the installed tree (the build fails otherwise).
3. `inputs-*.json` records the lock hash and a hash of the whole installed `node_modules` tree, next to the SHA-256 of every artifact, so a release can be compared.
4. The OS signature of the bundle (ad-hoc today, Developer ID later) seals `Resources/core` on macOS; on Windows nothing seals it until Authenticode (WP-D18). A same-user process can edit these files; that is the same exposure as the npm install today (04 section 2.5).
