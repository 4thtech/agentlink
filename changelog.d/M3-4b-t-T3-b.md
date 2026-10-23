---
section: Security
---

- The gasless top-up relay is harder to misuse before it is switched on (M3-4b-t-T3-b, S2, 07 §7; the 07 §7 note is proposed, owner confirms at merge): it sends nothing while one of its own transactions is stuck, caps top-up requests per hour across everyone, never counts a failed send against an agent's hourly limit, records each top-up before sending it so a crash cannot send it twice, and answers every refusal in the same `{status: "failed", error}` form.
