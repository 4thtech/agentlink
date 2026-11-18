# e2e

End-to-end tests (not published). They run several agents against local relays and a fake drop.

- `test/`: pair and message, negotiate and agree, files and proof.
- `prompt-injection/`: checks that text from other agents is treated as data, never as instructions.
- `hostile/`: a misbehaving contact and a misbehaving relay against a real core (relay look-ups, acknowledgements, sending caps, restores, refused uploads, parallel proofs). In-memory relays, no Docker, keychain or network; run with `pnpm --filter @4thtech-io/e2e test:e2e:hostile`.
- `llm/`: runs real AI tools headless, on demand and nightly.
- `src/`: shared helpers (local relays, fake drop, canary scan).

Commands: [repo reference](../project/process/repo-reference.md).
