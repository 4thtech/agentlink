# Development-machine resources: keep the Mac usable while workers run (RB-24)

| | |
|---|---|
| **Purpose** | Stop AI workers from overloading the owner's Mac: limits on parallel work, worktree cleanup, Spotlight, stopping runaway jobs, relay simulation, recovery after a crash. |
| **Who runs it** | The orchestrator before launching workers; every worker that writes or tests. |
| **Rules vs how** | The three key limits are one line in `AGENTS.md`. This runbook is the how. Where it disagrees with a process document, the process document wins. |

## Why this exists

On 20 and 21 Nov 2026 the owner's 5-core Mac hung and, after a forced restart, stuck at the login progress bar. In the end macOS was reinstalled. What we found:

- Parallel build workers each had their own git worktree under `.claude/worktrees/`. **776 worktrees** piled up, plus 29 older copies in `~/Projects` and `~`, many with `node_modules`: about **43 million files**.
- Spotlight (`mds`) and `fseventsd` kept indexing all of them.
- Up to 5 parallel vitest runs and browser screenshot harnesses pushed the load average to **100 to 212** (a healthy 5-core Mac stays near 5).
- One worker started Docker Desktop to simulate relays, and it stalled on a privileged-helper prompt.
- Ruled out: disk space (194 GB free), Docker disk, a kernel panic, memory (one Chrome jetsam event only).

The cause was too much parallel work plus too many files, not one bug. The limits below stop it from building up again.

## 1. Before launching workers

```bash
uptime                 # read the first load number (1 minute)
sysctl -n hw.ncpu      # number of cores
git worktree list | wc -l
```

- If the 1-minute load is **above the core count**, do not launch test-heavy work. Wait, or launch read-only and docs workers only.
- If the worktree count is **above 20**, clean up first (section 3) before launching anything that writes.
- If Spotlight or `fseventsd` shows high CPU in `ps -Ao pid,%cpu,comm -r | head`, wait for it to settle.

## 2. Concurrency limits

| What | Limit |
|---|---|
| Workers in total (all kinds) | **5** |
| Test-heavy workers at once (they run tests, builds or a browser) | **2**. Read-only, review and docs workers do not count. |
| vitest | Always `--maxWorkers=1`. One suite at a time. Targeted files only. |
| Full suites | Run in **CI**, never locally. |
| `packages/node` tests | Per file, in batches of at most 20 files. |
| Browser or Playwright harnesses | One at a time, never in parallel. Close the browser when done. |

Example of a local run: `pnpm --filter @4thtech-io/node exec vitest run src/some.test.ts --maxWorkers=1`.

A worker that needs more than this pushes the check to CI and says so in its report.

## 3. Worktree lifecycle

**Create.** Use `isolation: "worktree"` only for workers that **write**. Reviewers and readers use the main checkout read-only, or a scratch directory, and never run an install. Never run `pnpm install` into the shared repo from a scratch tree.

**Delete when the lane is merged.** One worktree per open lane, not one per task ever started. After **every release**, run the cleanup below.

**Check before deleting.** A worktree can hold unmerged or dirty work.

```bash
git worktree list | wc -l                       # count; alert above 20
git worktree list                               # path, commit, branch
# for each worktree you plan to remove:
git -C <path> status --short                    # dirty files?
git -C <path> log origin/main..HEAD --oneline   # commits not on main?
```

If there is unmerged or dirty work, save it to a branch first and push it. Never commit `node_modules` symlinks or local harness files; leave them out with `git add` of named files only.

```bash
git -C <path> switch -c wip/<lane>-<date>
git -C <path> add <named files>
git -C <path> commit -m "WIP <lane>"
git -C <path> push -u origin HEAD
```

**Remove.**

```bash
# normal: one worktree
git worktree remove <path>        # refuses a dirty tree, which is the point

# many at once: list all worktrees, pick the merged ones by hand, then remove
git worktree list --porcelain | awk '/^worktree /{print $2}' | grep '/.claude/worktrees/'

# big or stuck tree (node_modules makes remove slow): move aside, then prune
mv <path> ~/.Trash-agentlink-$(date +%s)   # same volume, instant
git worktree prune
nice -n 19 rm -rf ~/.Trash-agentlink-*     # low priority, see "big delete" in section 5

# also delete the merged branches
git branch --merged origin/main | grep -v '^[*+]\|main' | xargs -n 20 git branch -d
```

Old copies outside the repo (`~/Projects/agentlink-*`, copies in `~`) are not worktrees. Check each with `git status` and `git log origin/main..HEAD`, then delete them the same way. Never delete the main checkout at `~/Projects/agentlink`.

## 4. Spotlight

Spotlight indexing a repo with tens of thousands of files and many `node_modules` folders burns CPU for hours and keeps `fseventsd` busy.

- Exclude the projects folder: **System Settings > Spotlight > Search Privacy** (on older macOS: Siri & Spotlight), click **+** and add `~/Projects`. Add `~/Projects/agentlink-orchestrator` only if it is not under it.
- If a folder must stay out of the index but you cannot use the settings, give it a **`.noindex` suffix** (for example `scratch.noindex`); Spotlight skips folders with that suffix.
- Do not put scratch checkouts, worktrees or build output in `~` or Desktop or Documents.

## 5. Stopping things

Find what is eating the machine:

```bash
uptime
ps -Ao pid,%cpu,comm -r | head       # top CPU users
pgrep -fl vitest                     # all vitest processes
pgrep -fl 'chrome|playwright|chromium'
```

Stop it:

```bash
pkill -f vitest                      # stop test runs
pkill -f playwright                  # stop browser harnesses
kill <pid>                           # one process; kill -9 only if it will not die
docker ps                            # running containers (only if Docker is already open)
docker stop $(docker ps -q)          # stop all containers
osascript -e 'quit app "Docker"'     # quit Docker Desktop
```

Background agents: stop them from the Claude Code session list (or the Agent task list) before you start killing processes by hand; otherwise they restart the work.

**Big delete.** `rm -rf` on a worktree with `node_modules` touches millions of files. Move the folder aside first (section 3), then `nice -n 19 rm -rf <moved path>`. Expect `fseventsd` and `mds` to be busy while it runs, and do not launch workers until `uptime` is back near the core count.

## 6. Relay network simulation on this machine

How relays are simulated today (checked 21 Nov 2026):

- **E2E hostile suites** (`e2e/hostile/`, see `e2e/README.md`): an **in-memory relay network**, no Docker, no keychain, no network. This includes the misbehaving relay stand-ins. Run it with `pnpm --filter @4thtech-io/e2e test:e2e:hostile`, one suite file at a time.
- **`packages/node/src/relay-docker.test.ts`**: three real relays (strfry twice, rnostr once) started with `docker run`. It is opt-in (`AGENTLINK_REQUIRE_DOCKER=1`) and **CI runs it** (`relays-docker` job). Do not run it locally.
- There is **no docker-compose file** for relays in the repository.

Rules on this machine:

1. **Prefer the in-process stand-in relays** (the e2e hostile network and the helpers in `e2e/src/`). They cover almost everything a worker needs.
2. **Never start Docker Desktop from an agent without asking the owner.** It can stall on a privileged-helper prompt and take the machine with it.
3. If Docker is truly needed and the owner agrees:
   - cap the Docker Desktop VM first: **Settings > Resources: 2 CPUs, 4 GB memory**;
   - per container: `docker run --cpus=1 --memory=512m ...`;
   - **at most 4 relay containers** at once;
   - **stop and remove them after the run**: `docker rm -f <name>`, then quit Docker Desktop.

For a compose file, the same limits are `deploy.resources.limits` (`cpus: "1"`, `memory: 512M`) on each service. No compose file exists today, so there is nothing to patch; add the limits when one is created.

## 7. After a crash or a hang

1. Let the machine settle. After a forced restart macOS may spend a long time catching up on indexing; a long login progress bar is normal. Do not force restart again unless it has been stuck for hours.
2. Check `uptime` and `ps -Ao pid,%cpu,comm -r | head`. Wait until the 1-minute load is below the core count.
3. Count worktrees (`git worktree list | wc -l`) and clean up (section 3). Check for dirty or unmerged work first.
4. Confirm Spotlight excludes `~/Projects` (section 4).
5. Resume with **1 or 2 workers**, then add more one at a time while watching `uptime`.
6. Record what happened in the sync file and the handoff.
