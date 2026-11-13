---
section: Fixed
---

- Your master code no longer disappears on a reload (REL051-CF3, S2, 04 §2.3.3, 08 §1): reloading "Your master code" in Get started, or step 4 of a restore, shows the same code and step again until you click "I saved it" (kept in the app's memory for this window only, for at most 10 minutes, never on disk). If the app was closed before you saved it, the app now says "Your master code wasn't saved" and offers a new one with Touch ID instead of asking for a code you never saw. Closing the app right after "Restore 1 ID" no longer leaves a computer that asks for a master code nobody was shown: the next start goes back to "Finish restoring", and choosing the same kit again finishes with Touch ID and a new master code.
