---
section: Added
---

- Update the browser app from Settings › Updates, no terminal command (BROWSER-UPDATE, S2, 08 §1). When a newer version is out, press **Update now**: AgentLink gets the new version and checks it, then press **Restart now**. AgentLink closes and opens again in a new browser tab with the new version, in the same terminal window. Then quit and reopen your AI apps so they use the new version too. Your IDs, people and messages stay as they are. AgentLink installs only the exact version the npm registry names as the latest, and only when it was built by AgentLink's own release workflow and its signatures check out; no install scripts run. If you installed AgentLink with `npm install -g`, the page shows the one update command as before. The desktop apps keep their own updater.
