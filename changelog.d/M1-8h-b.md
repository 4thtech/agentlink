---
section: Changed
---

- Owner setup (M1-8h-b, S2, `@agentlink/node`; IR-M1-8h-1 Lows): `owner init` asks for the agent's name for contacts before the owner code is shown (Enter keeps the local agent name; up to 32 letters, digits, spaces, dots, apostrophes or hyphens in one script, accepted only if the contact-name rule shows it unchanged, so contacts see it as self-declared). If the first card fails, the rollback removes the owner key only while it is still the one this run stored, so a concurrent run's owner key is never deleted. The generic owner operation no longer signs agent cards at all; cards are signed only in the bound sessions of `owner init` and `owner add-agent`.
