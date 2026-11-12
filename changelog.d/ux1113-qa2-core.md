---
section: Fixed
---

- Kit, restore and rename fixes from the second full QA pass (UX1113-QA2-CORE, S2):
  - **Rename another ID.** Rename on an ID that isn't open no longer fails with "Couldn't rename it": like Pause and Invite, it opens that ID first, then the Rename editor.
  - **Damaged kit.** A half-copied kit with the right code now says "This kit file is damaged or incomplete" instead of "That code doesn't open this kit", and that answer doesn't count toward the wait. A wrong code still does. (A very small kit can't tell a cut file from a wrong code.)
  - **Not falsely backed up.** A kit counts as "You're backed up" only once it has opened with its code (step 3 of the save checklist, or Check my kit later). If you leave before that, Backup & restore says "Your last kit isn't finished". Leaving the page while a kit is being saved, or while its code and checklist are still on screen, now asks first.
  - **Names, not folders.** A restored ID keeps the name people know, also when it comes back under a new folder name. The kit-saved toast, Check my kit (for IDs already here) and the Rules row in Settings show the ID's name, not its folder.
