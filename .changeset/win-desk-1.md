---
'@4thtech-io/agentlink': patch
'@4thtech-io/desktop': patch
---

WIN-DESK-1: the Windows app's core accepts the app's private pipe (on Windows the pipe type is read from the file mode; a file, the null device, a console or an unknown handle is still refused), the pipe is opened for reading and writing at the same time, a data folder Windows cannot provide gets its own message instead of "another AgentLink is running", and the app log notes when the core is ready.
