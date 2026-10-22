---
'@4thtech-io/agentlink': patch
---

Every AgentLink tool result now names one plain next action: a result waiting for approval says to call agentlink_get_approval to check the decision, the folder-not-allowed result gives the exact terminal step, and invite and pairing results drop the unavailable safety-code command and the unavailable keystore and ui commands.
