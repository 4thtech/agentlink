---
section: Added
---

- Test a server before you use it (NET-PRECHECK, S2, 04 §4, 07 §4.3, 08 §1): under Advanced › Message network, the app can check up to 8 server addresses from this computer. Only public `wss://` servers pass (no IP addresses, no home-network or local names, every DNS answer public and pinned); a one-time key, never your ID's key, publishes a tiny test message and a fresh connection reads it back. Each server is ready, slow (over 1 s, still usable), needs sign-in, needs payment, or refused with a plain reason; at most 10 tests a minute, 15 s each. It changes nothing and is not available to AI apps.
