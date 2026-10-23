---
'@4thtech-io/agentlink': patch
---

`init` names Cursor and Windsurf when it finds no app, and its confirmation code now binds the exact Windsurf file it will write (with `$XDG_CONFIG_HOME` or `%APPDATA%` applied), so a code shown for one location never confirms a write to another (M1-36g-b, M1-36g-c).
