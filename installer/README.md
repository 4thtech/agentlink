# One-line installer

Install AgentLink by pasting one line into a terminal you opened yourself (owner Decision 58). The installer checks what is missing, installs it, and opens the app. It bridges the gap until signed desktop apps exist.

| Computer | Paste this |
|---|---|
| Mac or Linux (Terminal) | `curl -fsSL https://agentlink.4thtech.io/install.sh \| sh` |
| Windows (PowerShell) | `irm https://agentlink.4thtech.io/install.ps1 \| iex` |
| Windows (Command Prompt) | `powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 \| iex"` |

Already have Node.js 22.14 or newer? `npx -y @4thtech-io/agentlink@latest` works without the installer.

## What it does

1. **Node.js.** If `node` 22.14 or newer (with `npx` next to it) is on your PATH, it uses that. Otherwise it downloads the official Node.js **22.23.4** (LTS) from `https://nodejs.org/dist/v22.23.4/` into a folder of its own: `~/.agentlink/runtime` (Mac, Linux) or `%LOCALAPPDATA%\AgentLink\runtime` (Windows). Before unpacking, the SHA-256 of the download must equal **both** the line in that release's `SHASUMS256.txt` (fetched over HTTPS from nodejs.org) **and** the hash written in the installer. Any mismatch stops the install and nothing is installed.
2. **The `agentlink` command.** A small launcher that runs `npx -y @4thtech-io/agentlink@latest` with that Node.js, with the npm registry pinned to `https://registry.npmjs.org/` on the command line (for the `@4thtech-io` scope too), and `--prefix` set to the AgentLink folder, so an `.npmrc` in the folder you start it from is not read (no registry, proxy, TLS or `node-options` from there): `~/.agentlink/bin/agentlink` (one marked line in `~/.profile`, and in `~/.zshrc` or your bash file, adds it to PATH) or `%LOCALAPPDATA%\AgentLink\bin\agentlink.cmd` (added to your user PATH). On Windows it is a `.cmd` file, so the PowerShell execution policy never blocks it.
3. **Opens the app**, when run from a terminal. Your browser opens on Welcome. Otherwise (for example in a script) it prints the command to run instead.

No sudo or admin rights, no system settings, no telemetry. It never asks for or prints a secret. Your IDs, contacts and messages live in `~/.agentlink` (outside `runtime` and `bin`); the installer never touches them.

## Options

| Mac, Linux | Windows | Does |
|---|---|---|
| `sh -s -- --dry-run` | `-DryRun` | Prints what it would do; changes nothing |
| `sh -s -- --uninstall` | `-Uninstall` | Removes the runtime, the command and the PATH entry; keeps your IDs |
| `sh -s -- --no-start` | `-NoStart` | Installs without opening the app |

On Mac or Linux: `curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall`. On Windows, options need the script block form: `& ([scriptblock]::Create((irm https://agentlink.4thtech.io/install.ps1))) -Uninstall`.

**Update:** run the same line again. AgentLink itself is always the newest version (`@latest`); a new installer brings a newer Node.js and replaces the old copy.

## Good to know

- **Windows uninstall and links.** `-Uninstall` deletes `%LOCALAPPDATA%\AgentLink\runtime` and `bin` recursively. Do not put a junction or symbolic link to another folder inside them: Windows PowerShell 5.1's `Remove-Item -Recurse` can follow a junction and delete the files it points to. The installer itself never creates one. (On Mac and Linux, `rm -rf` does not follow links.)
- The launcher keeps the folder you start it from, because commands such as `agentlink verify ./pack` name files relative to it.

## Not covered

Alpine Linux and other musl systems (install `nodejs` and `npm` from the system packages, then run the installer), 32-bit computers, and the fish shell's PATH (add `~/.agentlink/bin` yourself).

## For maintainers

- `install.sh` is POSIX sh and shellcheck-clean; `install.ps1` runs on Windows PowerShell 5.1 and PowerShell 7. Both are plain ASCII.
- The invite site build (`apps/invite/vite.config.ts`) copies both files byte for byte to `/install.sh` and `/install.ps1`, served as `text/plain; charset=utf-8` with `Cache-Control: no-store` (`apps/invite/site/_headers`), so a fix is live as soon as the invite deploy runs. The deploy's site check compares the served bytes with the build.
- **Bumping Node.js:** change the version in both scripts and the six hashes, taken from that release's `SHASUMS256.txt` after verifying `SHASUMS256.txt.asc` with gpg against the Node.js release keys (github.com/nodejs/release-keys). Update `tools/installer/fixtures.mjs` the same way.
- Tests: `tools/installer/` (sandboxed runs of `install.sh` with a fake `curl`, `uname` and `node`; `install-ps1.tests.ps1` run with `pwsh`; shellcheck), `e2e/test/invite-page-*.test.ts` (the served files and headers) and `tools/release/deploy-invite.test.mjs` (the deploy's file list and site check).
