---
section: Fixed
---

- When AgentLink can't read your spending record, a proof is now refused at once with "save your limits again in Settings › Rules", instead of asking for an approval that could not let it through (BUDGET-BROKEN-UX, S1, 06 §3, 07 §3.5, 11 §5.11).
- A contact-details update that no message server accepted the first time is published again by the next pass (CARD-UPDATE-FAILED-STATE, S1, 07 §4.3).
- The notice that an ID is in use on another computer stays in Notifications even when 200 newer items fill the list (REL0514-DEVICES-CAP, S1).
- Tests: the later count update of a delivery has its own core test (DELIVERY-COUNTS-TEST, S0); the first-launch journey counts layout shift after fonts and the first paint settle, with the same budget (REL0514-CLS-SETTLE, S0).
