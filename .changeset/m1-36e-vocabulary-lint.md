---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
---

M1-36e: the last "run this" lines that still started with the bare `agentlink` (`doctor`, `policy`, `requests`, `credits`, `contacts`, the not-set-up and error messages, the tool hints for your AI, and the key, keychain, add-agent and change-code messages) now start with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. `doctor` and `status` say "message network" instead of "relays". A vocabulary check now keeps terminal text, tool hints, the approval page and the user guide free of technical words such as wallet, gas, transaction and chain.
