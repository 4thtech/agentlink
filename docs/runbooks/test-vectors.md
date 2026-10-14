# RB-06 · Cross-runtime test vectors

## Purpose
Prove that our crypto and EIP-712 code produces the same bytes in Node, browsers and Workers, against vectors that our own code did not generate. The harness (M0-9) lives in `test-vectors/`; its format and rules are in [`test-vectors/README.md`](../../test-vectors/README.md).

## When to use
Any change to a protocol suite (key derivation, envelope hash and signature, HPKE wrap, STREAM, pairing proof, EIP-712 including the AgentCard domain, NIP-44, safety code, owner wrap), and every new suite.

## Who runs it
An Opus builder: `test-vectors/**` is S2 (`audit-rules.md` §2.2). Vectors change only with a spec change.

## Preconditions
- The spec section that defines the suite exists; a vector without a spec is a spec gap.
- Browsers installed once per machine: `pnpm exec playwright install chromium firefox webkit`.
- `python3` for the generators, and for the protocol generators (M1-1h) a virtual environment with the hash-pinned packages of `tools/vectors/requirements.txt` (`test-vectors/README.md`, Rules 1); pass its interpreter as `VECTORS_PYTHON`.

## Steps
1. **Generator.** Write `tools/vectors/generate_<suite>.py`. It must not import repository TypeScript. Where published values exist, it cross-checks them and refuses to write on a mismatch. It supports `--write` (writes `test-vectors/<suite>/vectors.json`) and `--check [FILE]` (writes nothing; exits non-zero unless FILE equals its output). Model: `tools/vectors/generate_sha256.py`.
2. **Vectors.** Run it once and commit the output, plus `test-vectors/<suite>/case.schema.json`:
   ```bash
   python3 -I tools/vectors/generate_<suite>.py --write
   ```
3. **Suite module.** Add `test-vectors/harness/suites/<suite>.ts` and register it in `harness/suites/index.ts`. It returns `{ field, actual }` for every field of the case's `expected`. It never returns expected values; `harness/compare.ts` reads them from the vector. It calls `@agentlink/crypto`, never a crypto library or `crypto.subtle` directly.
4. **Tests first (S2).** Vectors that land before their code (M1-1h) are listed in `pendingSuites` (`harness/suites/index.ts`) with the implementing card, so CI stays green and reports them as pending. The implementing card removes the entry and adds the module; run it red locally first and record the evidence (commit SHA, command, output excerpt) in the PR body. Never push a failing state. Then implement.
5. **Run the checks:**
   ```bash
   VECTORS_PYTHON=.venv-vectors/bin/python node tools/vectors/check-generators.mjs   # every vectors.json equals its generator's output
   pnpm vectors:check                         # node, chromium, firefox, webkit, workerd
   ```
6. **Negative controls**, each restored afterwards (`git status` clean):
   - Flip one hex digit of one `expected` value: `vectors:check` fails for that case in all five runtimes, and `check-generators.mjs` fails.
   - Change one input byte: the same.
7. **Cross-repo parity:** the private contracts repository pins a public commit (or vectors release) and checks parity in its own gate (`development-process.md` §9.1, §9.3).

## Verify
- `pnpm vectors:check` ends with "passed in every runtime; test-vectors/ unchanged" and lists the five identities (`Node.js/…`, `HeadlessChrome/…`, `Firefox/…`, `AppleWebKit/… Version/…`, `Cloudflare-Workers`).
- The mutated-vector control failed in all five runtimes; record it in the PR.

## If it fails
- **One runtime differs:** a real portability bug until proven otherwise; do not "fix" the vector. Escalate.
- **"no passing runtime identity test" or a runtime MISSING:** a project ran somewhere else or not at all (for example, the browser or Workers project fell back to Node). Fix the config; never shrink `REQUIRED_RUNTIMES` in `tools/vectors/rules.mjs`.
- **"changed during the run":** a test wrote under `test-vectors/`. Tests only read vectors.
- **Provenance check fails:** the committed file is not what its generator produces. Regenerate only with a spec change.
- **CI fails at `pnpm exec playwright install`:** see lesson [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md).

## Related
- Card: M0-9 in [`backlog.md`](../process/backlog.md); also M1-1h and M1-1i (the suites).
- Rules: [`development-process.md`](../process/development-process.md) §10 (test vectors row), 04 §8.2.
- CI: the `vectors` job in [`ci-cd.md`](../process/ci-cd.md).
