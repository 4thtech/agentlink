---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

DEVICES-INTERIM: AgentLink notices when the same ID is also in use on another computer and says so in the app's notifications and in `agentlink doctor`: spending limits apply per computer until one ID can be used on several computers. The signal is the ID's own sent copy of a message this computer never wrote, so nothing new is sent to relays or contacts. Each computer gets a random install id, kept with the ID's keys on that computer only (never in a recovery kit, never sent anywhere), and every budget entry records it. Store schema version 20 adds the install id on budget entries and the one-row install state.
