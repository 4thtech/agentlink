---
section: Changed
---

- One command from an invite, no Node.js needed (WP-2, S2, 08 §4): the invite page now offers the one-line installer with the invite built in, for Mac or Linux (`curl … install.sh | sh -s -- --invite '<link>'`) and Windows PowerShell (`-Invite '<link>'`), chosen from your browser; Node.js 22.14 or later stays as the third choice. The installer checks the link with the same rules as `agentlink join`, refuses anything else with one fixed line without printing it, then opens AgentLink on the invite. "Ask your AI" and "Already have AgentLink? paste the link" stay.
- The installer says "AgentLink is installed." first and "Next time, open a new terminal and type: agentlink" after the app closes (F43); started from the installer's command, AgentLink names `agentlink` in its closing line (D4).
- The invite site has a favicon; its CSP allows images from the site itself only (`img-src 'self'`, F33).
