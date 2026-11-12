# RB-21 · Owner feedback loop: local first, CI once

## Purpose
Turn the owner's test feedback (screenshots, notes) into one agreed batch of fixes that he has seen working on his own machine, so CI runs once per batch and not once per small change (owner, 2026-11-02).

## When to use
The owner has tested the app (a release or a preview) and sends feedback on how it looks or behaves. Not for a security fix, a broken `main` or a release blocker: those go through the normal PR path ([RB-09](merge-and-release.md), [RB-08](ci-red.md)).

## Who runs it
The orchestrator (Opus) deploys the builders; Sonnet builds the fixes. The owner looks and says when it is good. The orchestrator never merges before that.

## Preconditions
- The feedback has task IDs on the backlog (`AGENTS.md`: no ID, no work).
- Node 22.14 or newer and `pnpm` in the worktree; the branch is built (`pnpm --filter '@4thtech-io/agentlink...' build` and the local UI) and copied, with its `e2e/` workspace, beside the launcher. The owner runs the launcher himself (`agentlink ui` needs a real terminal: [`apps/cli/src/commands/ui.ts`](../../apps/cli/src/commands/ui.ts)).

## Steps
1. **Fix locally on one branch.** One branch for the whole batch (`claim-task.md`, [RB-02](claim-task.md)). Commit each fix locally; push to the branch if you wish, but do **not** open a PR per fix. Run the tests of the packages you touched (`pnpm --filter '...<package>' test`).
2. **Start the unreleased build on the e2e harness, never on the real keychain.** A temporary `HOME` alone is **not** enough. It keeps the owner's real `~/.agentlink` out of the way, but it does not isolate the OS keychain: the keychain belongs to the OS user, and the owner's items have fixed names (service `agentlink`, accounts `owner` and `owner-passkey`, [`owner-keystore.ts`](../../packages/node/src/owner-keystore.ts)). A preview that runs Get started, Touch ID, Replace master code, Save a recovery kit or Restore on a plain temp `HOME` reads and can **overwrite the owner's real owner items**. (An earlier version of this runbook said a fresh `HOME` finds none of the owner's keychain items; that was wrong.)

   Use the owner test build launcher instead, as done for the redesign on 2026-11-12:
   - **What it runs.** A small runner on the e2e journey harness ([`e2e/test/journey/world.ts`](../../e2e/test/journey/world.ts) `journeyWorld()` and `startUiRun()`, with [`e2e/test/app-world.ts`](../../e2e/test/app-world.ts)): the built app in a brand-new `HOME`, the keychain stand-in **file** in that folder ([`e2e/src/file-keychain.mjs`](../../e2e/src/file-keychain.mjs); the macOS Keychain is never read or written), an in-memory relay ([`e2e/src/memory-relay.mjs`](../../e2e/src/memory-relay.mjs); nothing leaves the Mac), and AI-app settings looked up only inside that `HOME`. It is the same harness `pnpm docs:screens` uses ([docs architecture](../process/docs-architecture.md) §3). Optionally a small helper stands in for an AI app and sends one hello between two test IDs once they connect, so there is a real message to read.
   - **The launcher** is a double-click `.command` file in a shared folder outside every repo and outside the owner's home (on 2026-11-12: `/Users/Shared/AgentLink-test/`, with a built copy of the branch in `app/`). It makes a new folder per start (`redesign-home-<date-time>`), `unset`s `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `AGENTLINK_HOME`, sets `HOME` and `TMPDIR` to that folder, and runs the runner (`vitest run --config owner-preview/vitest.config.ts` inside the copy's `e2e/`). A second launcher can copy the newest recovery kit from earlier test folders into the new folder's `Downloads`, to test restore. The runner is not in the repo yet; keep it beside the launcher.
   - **What the owner sees.** The browser opens by itself at the one-shot session link. "Touch ID" in the browser is Chrome's own passkey prompt for `localhost`; **Continue with a master code only** works too. Closing the Terminal window (or Ctrl+C) stops everything.
   - Never start `ui` through a terminal tool for him (it bypasses the terminal guard, G-1, [`ui.ts`](../../apps/cli/src/commands/ui.ts)); he double-clicks the launcher. Never run `init` or `mcp` for a real AI app from a preview.
   - The plain `HOME="$(mktemp -d)" node apps/cli/dist/agentlink.js ui` route is only for screens that touch no owner item at all (nothing that asks for Touch ID or the master code, no backup or restore). When in doubt, use the harness launcher.

3. **Send the owner what he needs, and nothing else:** the build (branch and short commit), the `localhost` address once the page opened (or: "a browser tab opens by itself"), and the exact clicks, one per line, for each fix, for example: "1. Welcome → Create agent. 2. Home → Files: the empty state shows the folder icon." Say which feedback item each click checks.
4. **Repeat.** He looks and answers. Fix again, rebuild (step 2 builds again), send the next clicks. Every start of the launcher is a fresh test computer; delete old `redesign-home-*` folders when they are in the way.
5. **Only when he says it is good:** open **one** PR for the batch with `node tools/pr/open-pr.mjs`. Add the changeset and `changelog.d/` fragment. If the batch is S2 or touches a sensitive path, run the independent review first and put the `IR-…` line in the PR body ([RB-04](independent-review.md)); S0 and S1 elsewhere need none (Decision 54). CI runs once.
6. **Merge and release.** Arm auto-merge as in [RB-09](merge-and-release.md) step 4 (S2 and sensitive paths only after his "merge" in chat). Then the release follows his clicks: npm `latest` needs his approval; production deploys run through CI ([RB-10](deploy-and-verify.md)).
7. Clean up: close the launcher's Terminal window, delete the test folders, release the board row ([RB-01](session-start-end.md)). There is no keychain item to remove: the harness never wrote one.

## Verify
- The owner's last message says the batch is good, and each feedback item has a click he performed.
- Every preview ran through the harness launcher (keychain stand-in file, in-memory relay, fresh `HOME`), so neither the owner's real `~/.agentlink` nor his keychain items were touched. `security find-generic-password -s agentlink -a owner` shows the same item before and after (its modification date unchanged).
- Exactly one PR for the batch; its CI ran once on its final head.

## If it fails
- **No browser opens or the command prints a single line telling you to use your own terminal:** it ran without a terminal. Ask the owner to paste the commands in his own terminal.
- **The first-run page is not what you want to check:** the owner's real state cannot be copied in (keys, owner passphrase); describe the screen and click path instead, or make the test profile as the owner would on a new machine.
- **CI is red on the one PR:** [RB-08](ci-red.md). Do not split the batch to get green.
- **The owner sends new feedback while the PR is open:** if it is small, push it to the same branch before the merge; otherwise start the next batch.

## Related
- Rules: `AGENTS.md` "Merging and releases"; [`delivery-process.md`](../process/delivery-process.md) §7; [`development-process.md`](../process/development-process.md) §5.
- Other runbooks: [RB-02](claim-task.md), [RB-04](independent-review.md), [RB-09](merge-and-release.md).
