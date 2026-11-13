---
section: Added
---

- Touch ID and Windows Hello for approvals in the desktop app (DESK-D12c, S2, 04 §2.3.4, §2.5): the setup screen offers "Turn on Touch ID for approvals" (or Windows Hello, one gesture), and from then on the confirm screens show "Use Touch ID" / "Use Windows Hello" first, with "Use your backup code instead" kept. One gesture approves one action; a paid action still confirms exactly the statement on screen. While builds are unsigned this is as strong as the passkey, not stronger. The browser is unchanged.
- The Touch ID key format refuses more unsafe values (DESK-D12c, folding in the Fable review of DESK-D12a): a peer key with the X coordinate of G or of the device key, a Windows key that is not RSA-2048 to 4096, and a signature whose length is not the key's.
- Settings has "Use Touch ID for approvals" (or Windows Hello) in the desktop app (DESK-D12c, Fable review M1): turn it off, or on again after a fingerprint or sign-in change, confirmed with your backup code. A credential turned off is never accepted again.
