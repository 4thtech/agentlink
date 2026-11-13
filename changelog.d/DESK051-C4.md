### Added

- Desktop app release (DESK051-C4, WP-D11): each npm `latest` release now builds the AgentLink app for Mac (Apple silicon and Intel) and Windows and attaches it to the GitHub Release as `AgentLink-<version>-mac-arm64.dmg`, `AgentLink-<version>-mac-x64.dmg` and `AgentLink-<version>-win-x64-setup.exe`, with `SHA256SUMS-desktop-app.txt`. The builds are unsigned for now; each `.dmg` carries "Read me first" with the first-open steps.

### Changed

- Desktop app (DESK051-C4): release builds have update checks off until the update key is set up, so the app never looks for updates and no build can carry the placeholder key. Get new versions from the Releases page.
