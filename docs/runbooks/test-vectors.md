# RB-06 · Cross-runtime test vectors (placeholder until M0-9)

> **Placeholder.** The vector harness does not exist yet; card **M0-9** builds it. This page describes the intended flow from that card so builders can plan around it. Replace the steps with exact commands in the M0-9 PR. Until then, do not invent a vector format or commit vectors.

## Purpose
Prove that our crypto and EIP-712 code produces the same bytes in Node, browsers and Workers, against vectors that our own code did not generate.

## When to use
Any change to a protocol suite (key derivation, envelope hash and signature, HPKE wrap, STREAM, pairing proof, EIP-712 including the AgentCard domain, NIP-44, safety code, owner wrap), and every new suite.

## Who runs it
An Opus builder: `test-vectors/**` is S2 (`audit-rules.md` §2.2). Vectors change only with a spec change.

## Preconditions
- M0-9 is `done` (it depends on M0-2d, the monorepo skeleton).
- The spec section that defines the suite exists; a vector without a spec is a spec gap.

## Steps
Intended flow, from the M0-9 card:
1. Produce the vectors with an **independent generator** (a different implementation or tool, named in the file), never with the code under test.
2. Commit them as JSON in `test-vectors/<suite>/`, shaped `{suite, version, generator: {tool, version}, cases[]}` and schema-validated.
3. Run the same suite modules in all three runtimes:
   ```bash
   pnpm vectors:check    # Node (Vitest), browsers (Playwright: Chromium, Firefox, WebKit), Workers (Miniflare/workerd)
   ```
4. Negative control: mutate one byte of one vector and confirm the run fails in **all three** runtimes; restore it.
5. Cross-repo parity: the private contracts repository pins a public commit (or vectors release) and checks parity in its own gate (`development-process.md` §9.1, §9.3).

## Verify
- `pnpm vectors:check` green in all three runtimes, and each runtime reports its identity (a silent fallback to Node fails the run).
- The mutated-vector control failed in all three.

## If it fails
- **One runtime differs:** a real portability bug until proven otherwise; do not "fix" the vector. Escalate.
- **CI fails at `pnpm exec playwright install`:** see lesson [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md); M0-9 adds the root `vectors:check` script together with a real `@playwright/test` devDependency.

## Related
- Card: M0-9 in [`backlog.md`](../process/backlog.md); also M1-1h and M1-1i (the suites).
- Rules: [`development-process.md`](../process/development-process.md) §10 (test vectors row), 04 §8.2.
