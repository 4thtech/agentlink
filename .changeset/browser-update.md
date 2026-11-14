---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
'@4thtech-io/local-ui': patch
---

BROWSER-UPDATE: Settings › Updates in the browser app gets Update now and Restart now. Update now installs the exact version the npm registry names as latest into `~/.agentlink/updates/<version>` with the npm that ships with Node (argv only, no shell, `--ignore-scripts`, the public registry forced), checks npm's sha512 integrity, `npm audit signatures` (registry signatures and provenance) and the installed name and version. Restart now closes this app host first, then runs the new version's `agentlink ui` in the same terminal; it opens in a new browser tab. A global npm install is updated in place only when this user can write it; otherwise the page keeps the one update command. Not reachable from MCP.
