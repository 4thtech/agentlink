---
'@4thtech-io/agentlink': minor
---

Free test credits finish the proof in the same call (M1-36i-c, M1-36f): after a claim that added free test credits, `agentlink_notarize` and `agentlink_send` with `notarize` wait up to 20 seconds for the credits to arrive (reading the agent's credits only) and then try the same proof exactly once more. No second claim and no second retry; if the credits have not arrived in time, the result is the plain `needs_credits` one. `needs_credits` now says the price and the amount missing in dollars, and `agentlink credits` drops "network" and "public record" from its output.
