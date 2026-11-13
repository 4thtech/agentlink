---
section: Added
---

- The core can now delete history on this computer (RET-3, S2, 04 §4.2, 07 §3.8, D-148): messages become tombstones that every read skips and that a relay cannot bring back, notarized messages keep their proof (the proof pack still verifies), protected items (pairing, terms, pending approvals and live commitments, the outbox) are kept, and saved Inbox files go to the Trash (macOS, Linux) only when unchanged since AgentLink saved them; nothing is ever deleted outright and nothing is sent to anyone. On Windows saved files are not moved yet (the app says to remove them yourself), and a deleted notarized message's content can no longer be shared in a proof pack. The Storage view counts saved files from the saved-file index. The app's delete screens come with RET-4; no AI tool can delete anything.
