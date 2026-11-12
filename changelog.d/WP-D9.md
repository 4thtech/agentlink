---
section: Added
---

- Invite deep link (WP-D9, S2, plan Decision 4, 08 §4): the invite page's command card adds "Open in the AgentLink app" (`agentlink://join#…`, built from the checked invite; your click hands it to the app on this computer, so the invite still reaches no server) and "Get the app (coming soon)". The desktop shell accepts only `agentlink://join#…`, rebuilds the canonical invite link and checks it with the same patterns as `agentlink join` before passing it to the app, which shows "Accept {name}'s invite?". Other schemes, crafted links, switches appended to a link and several links are ignored. The desktop app is not released yet.
