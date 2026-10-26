# e2e

End-to-end tests (not published). They run several agents against local relays and a fake drop.

- `test/`: pair and message, negotiate and agree, files and proof.
- `prompt-injection/`: checks that text from other agents is treated as data, never as instructions.
- `llm/`: runs real AI tools headless, on demand and nightly.
- `src/`: shared helpers (local relays, fake drop, canary scan).

Commands: [repo reference](../docs/process/repo-reference.md).
