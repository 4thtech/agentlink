---
'@agentlink/node': minor
---

Add the policy-version mark that protects an owner-signed policy from being rolled back. It is kept as a keychain item next to the agent's keys, rises only, under the agent's inter-process lock, and is read back after each update; a damaged item locks the policy instead of counting as "no policy yet". `openAgentStore` now returns it as `policyMark`, so a Node client passes it to the core and can apply owner-signed policies.
