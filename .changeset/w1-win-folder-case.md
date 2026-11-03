---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
---

Creating a new ID no longer fails at "Confirm it's you" when your home folder already has a folder named `agentlink` in another case (Windows, and macOS by default, ignore case in folder names). AgentLink now uses that folder under its real name for Send, Inbox and Proofs; links and anything that is not a plain folder are still refused.
