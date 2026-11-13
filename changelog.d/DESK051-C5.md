### Fixed

- Desktop app (DESK051-C5): opening AgentLink while another copy is still running never does nothing any more. The same app comes to the front; a different version or copy says "Another AgentLink is still open" (or "An older AgentLink is still open") and offers to quit it and switch. A copy that predates this check is named by the new one, which can quit it on a Mac.
- Desktop app (DESK051-C5): the Touch ID sheet for Replace master code now says "replace your AgentLink master code" instead of the text used for a routine approval.
- Desktop app (DESK051-C5): AgentLink also refuses to run from `/tmp` and `/private/tmp` (it offers to move itself to Applications), opens only this project's pages on GitHub, and leaves the app page as soon as its background service stops.
- Desktop release (DESK051-C5): attaching the app to a GitHub Release that does not exist now fails the job instead of passing with a warning, an installer already attached is never replaced with different bytes, and the job checks that every installer is on the release.

### Changed

- Desktop app (DESK051-C5): before it starts, the app checks that its bundled Node.js, background service and Touch ID helper are the files it was built with, and shows "Some of AgentLink was changed" otherwise. This catches broken or swapped files; it is not a protection against other programs running as you. "Read me first" in the `.dmg` now gives the exact macOS 15 steps, explains the Terminal line and shows how to check the download's SHA-256.
