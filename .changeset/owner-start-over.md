---
'@4thtech-io/agentlink': patch
---

OWNER-START-OVER: "Forgot your master code? Start over on this computer" in the Mac app, the Windows app and the browser app. AgentLink first offers Restore from recovery kit; to go on you type `start over` and confirm with Touch ID, Windows Hello or a passkey. It moves `~/.agentlink` to a dated backup folder (nothing is deleted), removes only AgentLink's own items from the Keychain or Credential Manager, then opens first run for a new master code. A step that fails is shown and can be tried again.
