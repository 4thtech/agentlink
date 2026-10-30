---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-SHORT-INVITE and W4-INVITES-LIST (D-139): new invites are short links, `https://agentlink.4thtech.io/i#2.<43 characters>`. The invite is encrypted on this computer (`ALI1`, AES-256-GCM under a key derived from the link secret) and uploaded to the encrypted drop under a lookup ID derived from the same secret; the link secret never leaves the link and is never stored or logged. If the drop is unavailable or does not answer within 10 s, the invite falls back automatically to the long link; `agentlink invite --long` and Advanced in the app's Add contact sheet make the long link on purpose. Every surface (the app, `agentlink accept`, `agentlink join`, `agentlink_accept_invite`, the invite page) accepts both forms and fetches a short link once. The local app lists open invites (name and expiry, never the link) with Cancel; cancel, completion and expiry delete the drop object, and a Cancel that races an answer still refuses it. `agentlink_create_invite` is now marked `openWorldHint: true`. Store schema version 8 (three invites columns).
