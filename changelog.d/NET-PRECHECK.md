---
section: Added
---

- Test a server before you use it (NET-PRECHECK, S2, D-158, 04 §4, 07 §4.3, 08 §1): under Advanced › Message network, the app checks up to 8 server addresses from this computer. Only public `wss://` servers pass (no IP addresses, no home-network or local names, every DNS answer public and pinned). A one-time key, never your ID's key, publishes a tiny test message that must be accepted without a login, and a fresh connection reads it back. Each server is ready, slow (over 1 s, still usable), sign-in (it wants a login to read) or refused with a plain reason; a paid server shows a warning. At most 10 tests a minute, 10 s per server. It changes nothing and is not available to AI apps.
