#!/usr/bin/env node
// CHORE-CI-SUPERSEDED: the `catch-up` job of deploy-submitter.yml and deploy-drop.yml. It runs when
// a deploy run did not deploy its commit because main moved on: the commit's CI was cancelled as
// superseded (wait-for-ci.mjs --superseded-ok), or deploy-production found a newer head of main.
// The newer commits may not touch the workflow's `paths`, so no push run exists for main's head,
// and the change would never deploy. This makes sure main's head has a run of the same workflow:
// unless a run for that commit (push or dispatch) is still in flight or finished successfully, it
// dispatches the workflow on main.
//
// CHORE-DEPLOY-CATCHUP: it also runs when this commit's own CI failed (a flake), and a finished run
// for the head that did not succeed no longer counts as handling it (76ad5c5c's run failed ci-green
// on a Playwright install timeout and production stayed days behind). Each run's catch-up job runs
// once and dispatches only for a head other than its own commit, so this cannot loop: a dispatched
// run whose head is still red ends at ci-green, and its own catch-up finds itself at the head.
// The run summary (GITHUB_STEP_SUMMARY, when set) says which head and which run deploy instead.
//
//   node tools/release/catch-up-deploy.mjs --workflow deploy-submitter.yml
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: write`, which may dispatch workflows
// of this repository and nothing more), GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_API_URL and
// GITHUB_STEP_SUMMARY (both optional).
// The dispatched run is an ordinary run on main: it waits for the head's own green CI and goes
// through staging, the smoke test, the production environment, DEPLOY_FREEZE and the head-of-main
// check like any push run. Dispatching never deploys anything by itself. Prints no token.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { githubApi, readEnv } from './wait-for-ci.mjs';

const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const HANDLED_BY = new Set(['push', 'workflow_dispatch']);

export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--workflow' || !WORKFLOW_FILE.test(argv[1] ?? '')) {
    throw new Error('usage: catch-up-deploy.mjs --workflow <workflow file name>');
  }
  return { workflow: argv[1] };
}

/** A run that is still going, or finished successfully, deploys (or deployed) its commit. */
function handles(run) {
  if (run?.status !== 'completed') return true;
  return run?.conclusion === 'success';
}

/**
 * Returns { action: 'none' | 'dispatched', head, runId? }. Throws when main's head cannot be read.
 * `summary` (optional) receives one Markdown line for the run summary.
 */
export async function catchUp({ api, repo, sha, workflow, log = console.log, summary = () => {} }) {
  const head = (await api(`/repos/${repo}/commits/main`))?.sha;
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    throw new Error('could not read the head of main');
  }
  if (head === sha) {
    log(`${sha} is still the head of main; nothing to catch up.`);
    summary(
      `**Not deployed:** \`${sha}\` is the head of main but did not pass every gate (for example its CI is not green); production keeps the previous version until a run for a newer green head of main, or a re-run of this one, deploys.`,
    );
    return { action: 'none', head };
  }
  const query = new URLSearchParams({ head_sha: head, branch: 'main', per_page: '50' });
  const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  const existing = (body?.workflow_runs ?? []).find(
    (r) =>
      r?.head_sha === head &&
      r?.head_branch === 'main' &&
      HANDLED_BY.has(r?.event) &&
      r?.path === `.github/workflows/${workflow}` &&
      handles(r),
  );
  if (existing) {
    const runId = Number.isSafeInteger(existing.id) ? existing.id : String(existing.id);
    log(
      `::notice::main moved on to ${head}; run ${runId} (${existing.event}, ${existing.status}) of ${workflow} handles it.`,
    );
    summary(
      `**Superseded by \`${head}\`:** this run did not change production; run ${runId} of ${workflow} (${existing.event}, ${existing.status}) deploys main's head.`,
    );
    return { action: 'none', head, runId };
  }
  await api(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: { ref: 'main' },
  });
  log(
    `::notice::main moved on to ${head} and no live or successful run of ${workflow} covers it: dispatched ${workflow} on main. That run deploys only once the head's own CI is green.`,
  );
  summary(
    `**Superseded by \`${head}\`:** this run did not change production; dispatched a new run of ${workflow} on main for that head (it deploys only once the head's own CI is green).`,
  );
  return { action: 'dispatched', head };
}

/** Appends one line to the run summary file, if the runner gave one. */
function summaryWriter(file) {
  if (!file) return () => {};
  return (line) => appendFileSync(file, `${line}\n`);
}

/** The command line. Returns the exit code. */
export async function run({ argv, env, api, log = console.log }) {
  try {
    const { workflow } = parseArgs(argv);
    const { token, repo, sha, baseUrl } = readEnv(env);
    await catchUp({
      api: api ?? githubApi({ token, baseUrl }),
      repo,
      sha,
      workflow,
      log,
      summary: summaryWriter(env.GITHUB_STEP_SUMMARY),
    });
    return 0;
  } catch (error) {
    log(`::error::Deploy catch-up failed: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
