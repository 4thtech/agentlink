---
'@4thtech-io/agentlink': patch
---

In the browser app, Settings › Updates shows your version and a Check for updates button, like the desktop app: one Updates page for both. When a newer version is out, it says "Restart AgentLink to update" (one-command installer, npx) or shows the one `npm install -g @4thtech-io/agentlink@latest` command with Copy (global install). The check asks only the npm registry for the latest version; nothing is installed from the page. (REL051-UPD2)
