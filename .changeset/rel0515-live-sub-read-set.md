---
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

The live inbox subscription follows the servers it should read: the background loop compares the subscription's read set with the current one each pass (store reads only) and reopens it when they differ, so turning on "Don't also announce on the default servers" stops reading the old public servers at once, and a leaving server stops being read when its 30 days end (REL-0515 F1).
