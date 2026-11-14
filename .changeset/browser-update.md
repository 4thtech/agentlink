---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
'@4thtech-io/local-ui': patch
---

BROWSER-UPDATE: Settings › Updates in the browser app gets Update now and Restart now. Update now first requires the registry's SLSA provenance for exactly that version (this repository's release workflow on main, the same sha512 as the tarball), then installs it into `~/.agentlink/updates/<version>` with the npm that ships with Node (argv only, no shell, no inherited npm configuration, empty npmrc files, `--ignore-scripts`, `--strict-ssl=true`, a lockfile, the public registry), requires every lockfile entry from registry.npmjs.org with sha512, `npm audit signatures` with nothing invalid or missing, and the installed name and version. Restart now closes this app host first (store and keys with it), records `updated`, then runs the new version's `agentlink ui` in the same terminal; it opens in a new browser tab. A global npm install keeps the one update command. Not reachable from MCP; `spawn` is limited to two source files by a new bundle-check source gate.
