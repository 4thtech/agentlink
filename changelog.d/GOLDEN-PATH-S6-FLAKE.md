---
section: Fixed
---

- The golden-path check for the app step (GOLDEN-PATH-S6-FLAKE, S0) no longer depends on which browser the CI runner image has: it now gives the test profile its own stand-in default browser and a capturing link opener, so "couldn't open your browser" on a headless runner cannot fail it. The launcher itself is unchanged: it already starts the default browser, or falls back to the system opener, as designed.
