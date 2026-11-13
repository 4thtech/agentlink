---
section: Changed
---

- Desktop apps decided (DESK-D0, D-145, S2, 03 §3/§6, 04 §2.2/§2.5/§7, 08 §8): macOS and Windows apps are an Electron shell around the same AgentLink core, AI apps keep their own connection as today, approvals get stronger in three phases (signed builds last), and updates are signed with keys kept offline. Early builds are unsigned; the backlog splits the work into DESK-D0 to DESK-D18, and `apps/desktop/**` and `apps/cli/src/desktop/**` are S2.
- New names for the codes (D-146, 11 §5.5): the backup code (terminal: owner code) becomes the **master code**; the optional 12-digit comparison is the **Contact check**; the owner fingerprint is hidden in the simple view and called the **ID tag** under the hood. The app's strings follow in one sweep.
