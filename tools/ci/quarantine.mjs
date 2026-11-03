#!/usr/bin/env node
// OPS-UNSTICK-A (report C8): a visible, expiring quarantine for evidence-backed flaky tests.
//
// The list is tools/ci/quarantine.json. Each entry names ONE test (`<repo path> > <describe> > ...
// > <test title>`), the CI job scope it applies to (`checks`, `node-os` or `e2e-browser`), the
// reason, the evidence (CI run and job), an owner (GitHub login), the date it was added and its
// expiry: at most MAX_DAYS later, at most MAX_ENTRIES entries. The limits live here, not in the JSON.
//
// A quarantined test still runs and is reported. While its entry is live, a failure of that test
// alone does not fail the job: it shows as a warning and in the run summary. Any other failure
// still fails, and so does a run that failed without a test report naming the failure (a crash, a
// failed build task). An expired or malformed entry fails CI: `check` runs in the `checks` job, and
// `evaluate` re-checks the list. Fix the test, or delete its entry, before it expires.
//
//   node tools/ci/quarantine.mjs check
//   node tools/ci/quarantine.mjs evaluate --scope node-os --exit-code "$status" --report <vitest.json> \
//     --run-record <run.json>
//   node tools/ci/quarantine.mjs evaluate --scope checks --exit-code "$status" --turbo-runs .turbo/runs
//
// `--turbo-runs`: the tests ran as `turbo run test --continue --summarize -- --reporter=json
// --outputFile.json=.vitest-report.json`; every task whose exit code is not 0 must have left
// `<its directory>/.vitest-report.json` and `.vitest-run.json`. The run record comes from
// tools/ci/vitest-run-reporter.mjs: an unhandled error or an interrupted run is never quarantinable
// (the JSON report does not list unhandled errors). Optional: --file <list> and --today <YYYY-MM-DD> (tests).
// Writes the run summary to GITHUB_STEP_SUMMARY when set.

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_ENTRIES = 5;
export const MAX_DAYS = 14;
export const SCOPES = new Set(['checks', 'node-os', 'e2e-browser']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEST_FILE_RE = /^[\w.@-]+(?:\/[\w.@-]+)*\.test\.(?:ts|tsx|mjs|js)$/;
const DEFAULT_FILE = resolve(import.meta.dirname, 'quarantine.json');
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const REPORT_NAME = '.vitest-report.json';
const RUN_NAME = '.vitest-run.json'; // tools/ci/vitest-run-reporter.mjs

const dayOf = (text) => {
  if (!DATE_RE.test(text ?? '')) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 86_400_000;
};

/** Checks the list against `today`. Returns { entries, problems }. */
export function validate(config, today) {
  const problems = [];
  const entries = config?.entries;
  if (!Array.isArray(entries))
    return { entries: [], problems: ['the list has no `entries` array'] };
  if (entries.length > MAX_ENTRIES) {
    problems.push(
      `the quarantine holds ${entries.length} entries; at most ${MAX_ENTRIES} are allowed`,
    );
  }
  const now = dayOf(today);
  if (now === null) problems.push(`bad date for today: ${JSON.stringify(today)}`);
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    const where = `entry ${i + 1} (${JSON.stringify(e?.id ?? '')})`;
    const parts = typeof e?.id === 'string' ? e.id.split(' > ') : [];
    if (parts.length < 3 || !TEST_FILE_RE.test(parts[0]) || parts.some((p) => p.trim() === '')) {
      problems.push(`${where}: id must be "<repo path of a test file> > <describe> > <test>"`);
    }
    if (!SCOPES.has(e?.scope))
      problems.push(`${where}: scope must be one of ${[...SCOPES].join(', ')}`);
    for (const field of ['reason', 'evidence']) {
      if (typeof e?.[field] !== 'string' || e[field].trim() === '') {
        problems.push(`${where}: ${field} is required`);
      }
    }
    if (!LOGIN_RE.test(e?.owner ?? '')) problems.push(`${where}: owner must be a GitHub login`);
    const added = dayOf(e?.added);
    const expires = dayOf(e?.expires);
    if (added === null || expires === null) {
      problems.push(`${where}: added and expires must be YYYY-MM-DD dates`);
    } else {
      if (expires < added || expires - added > MAX_DAYS) {
        problems.push(`${where}: expires must be within ${MAX_DAYS} days after added`);
      }
      if (now !== null && added > now) {
        problems.push(
          `${where}: added (${e.added}) is after today; date an entry on the day it is added`,
        );
      }
      if (now !== null && now > expires) {
        problems.push(
          `${where}: the quarantine expired on ${e.expires}. Fix the test or delete the entry (owner ${e.owner}).`,
        );
      }
    }
    const key = `${e?.scope} ${e?.id}`;
    if (seen.has(key)) problems.push(`${where}: listed twice`);
    seen.add(key);
  }
  return { entries, problems };
}

const slash = (p) => String(p).replace(/\\/g, '/');

/** Failed tests of a vitest JSON report as quarantine ids, and files that failed outside a test. */
export function failuresOf(report, root) {
  const base = `${slash(root).replace(/\/+$/, '')}/`;
  const failed = [];
  const fileErrors = [];
  for (const file of report?.testResults ?? []) {
    const name = slash(file?.name ?? '');
    // Case-insensitive prefix: Windows reports may spell the drive letter either way.
    const rel = name.toLowerCase().startsWith(base.toLowerCase()) ? name.slice(base.length) : name;
    const tests = file?.assertionResults ?? [];
    const bad = tests.filter((t) => t?.status === 'failed');
    for (const t of bad) failed.push([rel, ...(t.ancestorTitles ?? []), t.title].join(' > '));
    if (file?.status === 'failed' && bad.length === 0) fileErrors.push(rel);
  }
  return { failed, fileErrors };
}

/**
 * Decides a test step. `reports`: [{ file, report, run }] (report null when missing or unreadable;
 * run: the record of tools/ci/vitest-run-reporter.mjs, { unhandledErrors, reason }, or null).
 * Returns { ok, lines, summary }.
 */
export function evaluate({ config, today, scope, exitCode, reports, root }) {
  const lines = [];
  const summary = ['### Test quarantine (tools/ci/quarantine.json)', ''];
  const { entries, problems } = validate(config, today);
  for (const p of problems) lines.push(`::error::Test quarantine: ${p}`);
  const live = new Map(entries.filter((e) => e?.scope === scope).map((e) => [e.id, e]));

  const failed = [];
  const fileErrors = [];
  let missing = false;
  for (const { file, report, run } of reports) {
    if (!report) {
      missing = true;
      lines.push(`::error::Test quarantine: no readable test report at ${file}.`);
      continue;
    }
    // IR F3: the JSON report does not list unhandled errors; the run record does.
    if (exitCode !== 0) {
      if (!Number.isInteger(run?.unhandledErrors) || typeof run?.reason !== 'string') {
        missing = true;
        lines.push(`::error::Test quarantine: no run record (unhandled errors) for ${file}.`);
      } else if (run.unhandledErrors > 0 || run.reason === 'interrupted') {
        missing = true;
        lines.push(
          `::error::Test quarantine: ${file}: ${run.unhandledErrors} unhandled error(s), run ${run.reason}; not quarantinable.`,
        );
      }
    }
    const f = failuresOf(report, root);
    failed.push(...f.failed);
    fileErrors.push(...f.fileErrors);
  }
  for (const [id, e] of live) {
    const status = failed.includes(id) ? 'FAILED (quarantined)' : 'ran, not failed';
    summary.push(`- \`${id}\`: ${status}; owner @${e.owner}, expires ${e.expires}. ${e.reason}`);
  }
  if (live.size === 0) summary.push('No quarantined test in this job.');

  let ok = problems.length === 0;
  if (exitCode !== 0) {
    const real = failed.filter((id) => !live.has(id));
    for (const id of real) lines.push(`::error::Not quarantined, so it fails the job: ${id}`);
    for (const f of fileErrors)
      lines.push(`::error::${f} failed outside any test (not quarantinable).`);
    if (missing || reports.length === 0) ok = false;
    if (failed.length === 0) {
      lines.push(
        '::error::The tests failed, but no report names a failed test (a crash or a failed task).',
      );
      ok = false;
    }
    if (real.length > 0 || fileErrors.length > 0) ok = false;
    for (const id of failed.filter((x) => live.has(x))) {
      lines.push(
        `::warning::A quarantined test failed (it does not fail the job until ${live.get(id).expires}): ${id}`,
      );
    }
  }
  summary.push('', ok ? 'Result: pass.' : 'Result: fail.');
  return { ok, lines, summary };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The vitest reports a turbo run must have left: one per task that did not exit 0. */
function turboReports(runsDir, root) {
  const files = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(runsDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  const summary = files.length > 0 ? readJson(files[0]) : null;
  if (!Array.isArray(summary?.tasks)) {
    return [{ file: `${runsDir}/<turbo run summary>`, report: null }];
  }
  const out = [];
  for (const task of summary.tasks) {
    const code = task?.execution?.exitCode;
    if (code === 0) continue;
    const dir = typeof task?.directory === 'string' ? task.directory : '';
    const file = join(root, dir, REPORT_NAME);
    const ok = typeof code === 'number' && dir !== '' && !dir.split(/[\\/]/).includes('..');
    out.push({
      file: `${task?.taskId ?? 'a task'}: ${file}`,
      report: ok ? readJson(file) : null,
      run: ok ? readJson(join(root, dir, RUN_NAME)) : null,
    });
  }
  return out;
}

function parse(argv) {
  const [command, ...rest] = argv;
  if (command !== 'check' && command !== 'evaluate')
    throw new Error('usage: quarantine.mjs check|evaluate ...');
  const args = { command, reports: [], runRecords: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--file') args.file = value;
    else if (flag === '--today') args.today = value;
    else if (flag === '--scope') args.scope = value;
    else if (flag === '--exit-code') args.exitCode = value;
    else if (flag === '--report') args.reports.push(value);
    else if (flag === '--run-record') args.runRecords.push(value);
    else if (flag === '--turbo-runs') args.turboRuns = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (command === 'evaluate') {
    if (!SCOPES.has(args.scope))
      throw new Error(`--scope must be one of ${[...SCOPES].join(', ')}`);
    if (!/^\d+$/.test(args.exitCode ?? '')) throw new Error('--exit-code is required');
  }
  return args;
}

/** The command line. Returns the exit code. */
export function run({ argv, env = process.env, root = REPO_ROOT, log = console.log }) {
  try {
    const args = parse(argv);
    const config = readJson(args.file ?? DEFAULT_FILE);
    const today = args.today ?? new Date().toISOString().slice(0, 10);
    const write = env.GITHUB_STEP_SUMMARY
      ? (l) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${l}\n`)
      : () => {};
    if (args.command === 'check') {
      const { entries, problems } = validate(config, today);
      for (const p of problems) log(`::error::Test quarantine: ${p}`);
      if (problems.length === 0)
        log(`Test quarantine: ${entries.length} live entr${entries.length === 1 ? 'y' : 'ies'}.`);
      return problems.length === 0 ? 0 : 1;
    }
    const exitCode = Number(args.exitCode);
    const reports = args.turboRuns
      ? exitCode === 0
        ? []
        : turboReports(args.turboRuns, root)
      : args.reports.map((file, i) => ({
          file,
          report: readJson(file),
          run: args.runRecords[i] ? readJson(args.runRecords[i]) : null,
        }));
    const result = evaluate({ config, today, scope: args.scope, exitCode, reports, root });
    for (const l of result.lines) log(l);
    for (const l of result.summary) write(l);
    return result.ok ? 0 : 1;
  } catch (error) {
    log(`::error::Test quarantine: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run({ argv: process.argv.slice(2) });
}
