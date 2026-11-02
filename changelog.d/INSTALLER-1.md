---
section: Added
---

- One line installs AgentLink on macOS, Linux and Windows (INSTALLER-1, owner Decision 58): `curl -fsSL https://agentlink.4thtech.io/install.sh | sh` or, on Windows, `irm https://agentlink.4thtech.io/install.ps1 | iex`. It uses your Node.js 22.14 or newer, or downloads the official Node.js from nodejs.org for AgentLink only and checks it against nodejs.org's list and a hash in the installer. It adds an `agentlink` command with no admin rights and opens the app. Run it again to update; `--dry-run` and `--uninstall` are there too.
