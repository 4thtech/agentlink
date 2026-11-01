### Fixed

- AgentLink now starts from Claude Desktop, Claude Code, Cursor, Codex and the other AI apps on Windows: the entry `init` and the app write there starts with `cmd /c npx`, because those apps cannot start `npx` itself. Entries written before are still recognised and are updated the next time you connect (W5-WINDOWS, S1).
- A new Windows check installs the packed CLI, runs it, connects an AI app into a temporary profile and starts the MCP server on every change to the CLI, and the Windows download is opened on a Windows machine before each release. The Windows suite of `@4thtech-io/node` is now required in the merge queue (W5-WINDOWS).
- Releases to the `next` preview no longer stall waiting for a CI job that has a different name on integration branches (W5-WINDOWS).

### Added

- A Windows section in the user guide: PowerShell steps, the Node.js version, the SmartScreen prompt and the unsigned download (W5-WINDOWS).
