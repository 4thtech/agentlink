# RB-21 · Owner feedback loop: local first, CI once

## Purpose
Turn the owner's test feedback (screenshots, notes) into one agreed batch of fixes that he has seen working on his own machine, so CI runs once per batch and not once per small change (owner, 2026-11-02).

## When to use
The owner has tested the app (a release or a preview) and sends feedback on how it looks or behaves. Not for a security fix, a broken `main` or a release blocker: those go through the normal PR path ([RB-09](merge-and-release.md), [RB-08](ci-red.md)).

## Who runs it
The orchestrator (Opus) deploys the builders; Sonnet builds the fixes. The owner looks and says when it is good. The orchestrator never merges before that.

## Preconditions
- The feedback has task IDs on the backlog (`AGENTS.md`: no ID, no work).
- A Node 22.14 or newer and `pnpm` in the worktree; the owner's terminal or the orchestrator's terminal tab is free to run a foreground process (`agentlink ui` needs a real terminal: [`apps/cli/src/commands/ui.ts`](../../apps/cli/src/commands/ui.ts)).

## Steps
1. **Fix locally on one branch.** One branch for the whole batch (`claim-task.md`, [RB-02](claim-task.md)). Commit each fix locally; push to the branch if you wish, but do **not** open a PR per fix. Run the tests of the packages you touched (`pnpm --filter '...<package>' test`).
2. **Start the unreleased build on a test profile.** From the worktree root:
   ```bash
   pnpm --filter '@4thtech-io/agentlink...' build
   export PREVIEW_HOME="$(mktemp -d)"
   HOME="$PREVIEW_HOME" node apps/cli/dist/agentlink.js ui
   ```
   - `HOME` is the only switch: the CLI keeps its data under `<home>/.agentlink` (agents, `app.json`), so a temporary `HOME` never touches the owner's real `~/.agentlink`. A fresh profile starts at the first-run page (Welcome), which also tests that path.
   - The OS opens the browser at a one-shot `localhost` session link. The CLI never prints that link and an agent without a terminal cannot start the page (G-1, [`ui.ts`](../../apps/cli/src/commands/ui.ts)). So run the command in a terminal tab the owner can see (`mcp__terminal__run_in_terminal` when the harness has it) or give him the three lines to paste. The server runs until Ctrl+C.
   - Do **not** run `init` or `mcp` for an AI app from this profile: that would write the AI apps' real configuration files (they live under the user's real directories, not the temp `HOME`). Test the app pages only, unless the owner asks for an AI-app check and says which.
   - The OS keychain belongs to the OS user, not to `HOME`. A fresh profile has no agents, so it finds none of the owner's keychain items; name any test agent `preview-<date>` so it cannot clash, and delete it at the end.
3. **Send the owner what he needs, and nothing else:** the build (branch and short commit), the `localhost` address once the page opened (or: "a browser tab opens by itself"), and the exact clicks, one per line, for each fix, for example: "1. Welcome → Create agent. 2. Home → Files: the empty state shows the folder icon." Say which feedback item each click checks.
4. **Repeat.** He looks and answers. Fix again, rebuild (step 2 builds again), send the next clicks. Stop the server (Ctrl+C) and delete the profile between rounds if the state is in the way: `rm -rf "$PREVIEW_HOME"`.
5. **Only when he says it is good:** open **one** PR for the batch with `node tools/pr/open-pr.mjs`. Add the changeset and `changelog.d/` fragment. If the batch is S2 or touches a sensitive path, run the independent review first and put the `IR-…` line in the PR body ([RB-04](independent-review.md)); S0 and S1 elsewhere need none (Decision 54). CI runs once.
6. **Merge and release.** Arm auto-merge as in [RB-09](merge-and-release.md) step 4 (S2 and sensitive paths only after his "merge" in chat). Then the release follows his clicks: npm `latest` needs his approval; production deploys run through CI ([RB-10](deploy-and-verify.md)).
7. Clean up: stop the server, `rm -rf "$PREVIEW_HOME"`, remove any `preview-<date>` keychain item, release the board row ([RB-01](session-start-end.md)).

## Verify
- The owner's last message says the batch is good, and each feedback item has a click he performed.
- Every preview command ran with `HOME="$PREVIEW_HOME"`, so the owner's real `~/.agentlink` was not touched.
- Exactly one PR for the batch; its CI ran once on its final head.

## If it fails
- **No browser opens or the command prints a single line telling you to use your own terminal:** it ran without a terminal. Start it in a visible terminal tab, not through a plain shell call.
- **The first-run page is not what you want to check:** the owner's real state cannot be copied in (keys, owner passphrase); describe the screen and click path instead, or make the test profile as the owner would on a new machine.
- **CI is red on the one PR:** [RB-08](ci-red.md). Do not split the batch to get green.
- **The owner sends new feedback while the PR is open:** if it is small, push it to the same branch before the merge; otherwise start the next batch.

## Related
- Rules: `AGENTS.md` "Merging and releases"; [`delivery-process.md`](../process/delivery-process.md) §7; [`development-process.md`](../process/development-process.md) §5.
- Other runbooks: [RB-02](claim-task.md), [RB-04](independent-review.md), [RB-09](merge-and-release.md).
