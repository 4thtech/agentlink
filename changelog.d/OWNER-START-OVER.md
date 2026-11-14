---
section: Added
---

- Forgot your master code? Start over on this computer (OWNER-START-OVER, S2, D-152, 04 §2.5.4): from any master code field, the app warns what is lost, offers Restore from recovery kit first, then asks you to type `start over` and confirm with Touch ID, Windows Hello or a passkey. It moves `~/.agentlink` to `~/.agentlink.backup-YYYYMMDD-HHMMSS` (never deletes it), removes only AgentLink's own Keychain or Credential Manager items, and opens first run for a new master code. A failed step is shown and safe to retry. No MCP tool can start it.
