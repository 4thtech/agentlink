---
section: Security
---

- Recovery kit backup and restore hardening (REL051-SF3, S2, 04 §2.3.3): on a computer with no owner but a leftover passkey copy of the owner key, restoring that owner's kit now finishes with the owner restored, and first run sends you to "Finish restoring" instead of refusing; a leftover of another owner is never replaced and the restore stops before anything is written. The kit's header and contents are read from one file, a second restore running at the same time no longer removes the first one's files, a restore that brings back none of the chosen IDs no longer creates an owner or says "done", leftover restore files are removed when the app starts, wrong master codes on the restore step count toward the same wait as every other approval, and a recovery kit is saved in your home folder when Downloads is a link to another folder.
