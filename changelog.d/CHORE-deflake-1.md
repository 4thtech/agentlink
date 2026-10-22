---
section: Fixed
---

- Two flaky checks no longer fail at random (CHORE-DEFLAKE-1, test-only): the submitter rate-limit tests no longer break when a run crosses the top of the hour, and the prompt-injection test no longer mistakes the owner approval command for injected text.
