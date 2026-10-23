### Changed

- `agentlink init` lists Cursor and Windsurf among the apps it looks for when it finds none (M1-36g-b, S1, 08).

### Fixed

- `agentlink init`: for Windsurf with `$XDG_CONFIG_HOME` (macOS, Linux) or `%APPDATA%` (Windows) set, the confirmation code now binds the file that is shown and written, and that path is resolved once; a code shown with one environment no longer confirms a write under another (M1-36g-c, S1, 06 §7).
