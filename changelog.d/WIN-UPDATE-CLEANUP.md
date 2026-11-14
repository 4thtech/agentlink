---
section: Fixed
---

- After a Windows update, the old copy's folder beside AgentLink is removed reliably: AgentLink tries again for a short while if Windows still has a file in it open, and tidies up at the next start otherwise (WIN-UPDATE-CLEANUP, S2, 08 §8). The update itself was never affected.
