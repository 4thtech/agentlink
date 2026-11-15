# @4thtech-io/desktop

## 0.0.3

### Patch Changes

- 18b26c5: WIN-UPDATE-CLEANUP: after a good Windows update the helper retries removing the old copy for up to 30 s with backoff (a file in it can stay in use for a moment after its process ended, for example while antivirus scans it), and the next healthy start removes a copy a finished helper left, instead of waiting 24 h for its staging folder to be swept. The update itself never waits on this.

## 0.0.2

### Patch Changes

- 49f23b1: UPD-BUTTON-FIX: Settings › Updates "Update now" and "Restart now" work in the Mac app. The page's API client now sends a POST with no body as an empty `application/octet-stream` request, the one form the server's gate takes for routes with no input (it used to answer 415 before the update desk ran, and the page redrew the same card in silence). The same fix makes the recovery kit's Show in Finder reach its route. A refused or failed Update now or Restart now now shows one plain line on the card.
- 49f23b1: WIN-INAPP-UPDATE: the Windows app updates itself from Settings › Updates (Update now, then Restart now), on the same signed update document as the Mac app. The app downloads the Windows setup, checks its size and SHA-256 against the signed document, and after Restart now a small helper waits for the app to close, moves the old copy aside, runs the setup silently, starts the new version and keeps the old one if anything fails. The release's update document now lists the Windows setup. The setup upgrades silently in place and never skips a file it cannot write.

## 0.0.1

### Patch Changes

- 5507e7d: CI-823: the Mac update check reads the new app's Info.plist through one handle opened without following links (type and size from that same handle), so the file cannot change between the check and the read.
- 5507e7d: UPD-5: Settings › Updates in the Mac app gets Update now, download progress, Restart now and a "Couldn't update here" fallback with the download link (off while no update key is pinned). UPD-4b: the update helper treats a failing process list as unknown and starts the app again when a failed copy cannot be moved aside.
- 5507e7d: WIN-DESK-1: the Windows app's core accepts the app's private pipe (on Windows the pipe type is read from the file mode; a file, the null device, a console or an unknown handle is still refused), the pipe is opened for reading and writing at the same time, a data folder Windows cannot provide gets its own message instead of "another AgentLink is running", and the app log notes when the core is ready.
