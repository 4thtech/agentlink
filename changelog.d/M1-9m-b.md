---
section: Added
---

- `agentlink policy recover` (M1-9m-b, S2, D-100, 06 §8): when your rules can't be used (for example an older copy was put back), this command, in a terminal you opened yourself, says what went wrong, shows you the full rules it would sign (your last rules if they are still signed by you, otherwise the starting rules), and signs them only after you type `y` and your owner code. `agentlink doctor` now tells you when to run it.
- `agentlink policy allow-folder` (M1-9m-b, S2, D-99, 04 §4) now refuses a folder that holds a private folder, such as `~/Library` (which holds `~/Library/Keychains`), before asking for your owner code, and names the private folder so you can choose a narrower one.
