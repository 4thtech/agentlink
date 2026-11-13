---
section: Security
---

- Mac in-app update, the button (UPD-5 and UPD-4b, S2): Settings › Updates gets **Update now**, a download progress bar, "Checking the new version", **Restart now** (on a click, with a note when a request waits for your approval), "Restarting" and "Couldn't update here. Download the new version instead." with the download link. The two new pipe messages and routes carry no values (owner session with CSRF); the app installs only an update it verified itself and checks it again right before the restart. Not switched on yet: it stays off while the app pins no update key, so the page keeps today's download link. The update helper also keeps a copy it could not confirm as stopped, and starts the app again when it cannot move a failed copy aside.
