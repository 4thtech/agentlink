# @4thtech-io/desktop

## 0.0.1

### Patch Changes

- 5507e7d: CI-823: the Mac update check reads the new app's Info.plist through one handle opened without following links (type and size from that same handle), so the file cannot change between the check and the read.
- 5507e7d: UPD-5: Settings › Updates in the Mac app gets Update now, download progress, Restart now and a "Couldn't update here" fallback with the download link (off while no update key is pinned). UPD-4b: the update helper treats a failing process list as unknown and starts the app again when a failed copy cannot be moved aside.
- 5507e7d: WIN-DESK-1: the Windows app's core accepts the app's private pipe (on Windows the pipe type is read from the file mode; a file, the null device, a console or an unknown handle is still refused), the pipe is opened for reading and writing at the same time, a data folder Windows cannot provide gets its own message instead of "another AgentLink is running", and the app log notes when the core is ready.
