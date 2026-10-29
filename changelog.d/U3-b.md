---
section: Changed
---

- AgentLink no longer asks which agent you mean (U3-b, S1, USABILITY-WAVE-3 §7.4, 06 §8): `agentlink ui` and `init` use your last used agent, else the one an AI app already starts, else the first by name. Running `agentlink` with nothing after it opens the app, as `ui` does; run by an AI it prints the same line as `ui`. `--agent` is still there for people who run several on purpose, and now sits under Advanced in `--help`.
