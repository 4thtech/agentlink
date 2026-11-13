### Added

- Desktop app updates (DESK051-UPD, S2, 08 §8): Settings › Updates shows the version you have and a Check for updates button, and the app looks for a newer version by itself at most once a day. When one is out, the page says which version is ready; Download update opens the release file for your Mac in your browser, with short steps to replace the app. The app asks only GitHub's latest-release page of this repository, sends nothing about you, and downloads or installs nothing by itself; offline, or with `AGENTLINK_UPDATE_CHECK=off`, it does not check.
