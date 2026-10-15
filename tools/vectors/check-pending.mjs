// Pending vector suites (M1-1h, IR-M1-1h-1 F2). Writes nothing.
//
//   node tools/vectors/check-pending.mjs --base <git ref>
//     CI: test-vectors/pending-suites.json may only shrink against the base branch (main). A suite
//     that has vectors on the base and is not pending there can never become pending again, and
//     the same holds for single pending cases (`cases`, M1-7d).
//   node tools/vectors/check-pending.mjs --gate <phase>[,<phase>...]
//     Release gate: fails while any suite of a listed phase is pending (release.yml runs it with
//     M1a; docs/runbooks/test-vectors.md).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardPhases,
  checkPendingCaseShrinks,
  checkPendingCards,
  checkPendingGate,
  checkPendingShrinks,
  pendingCaseEntries,
} from './rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PENDING = 'test-vectors/pending-suites.json';

function parsePending(text) {
  const suites = JSON.parse(text)?.suites;
  if (typeof suites !== 'object' || suites === null || Array.isArray(suites)) {
    throw new Error(`${PENDING} has no "suites" object`);
  }
  return new Map(Object.entries(suites));
}

/** The optional `cases` object: single cases of an implemented suite left to a later card. */
function parsePendingCases(text) {
  const cases = JSON.parse(text)?.cases ?? {};
  if (typeof cases !== 'object' || cases === null || Array.isArray(cases)) {
    throw new Error(`${PENDING} has a "cases" value that is not an object`);
  }
  return new Map(Object.entries(cases));
}

function git(args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.error) throw run.error;
  return run;
}

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = option('--base');
const gate = option('--gate');
if ((base === undefined && gate === undefined) || args.length % 2 !== 0) {
  console.error('usage: check-pending.mjs [--base <git ref>] [--gate <phase>[,<phase>...]]');
  process.exit(2);
}

const problems = [];
const cards = cardPhases(readFileSync(join(root, 'docs/process/backlog.md'), 'utf8'));
const headPath = join(root, PENDING);
const headText = existsSync(headPath) ? readFileSync(headPath, 'utf8') : undefined;
const head = {
  pending: headText === undefined ? new Map() : parsePending(headText),
  cases: headText === undefined ? new Map() : parsePendingCases(headText),
};

if (base !== undefined) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(base)) {
    console.error('check-pending: --base must be a plain git ref');
    process.exit(2);
  }
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    console.error(`check-pending: base ref "${base}" not found (fetch it first)`);
    process.exit(2);
  }
  const shown = git(['show', `${base}:${PENDING}`]);
  const basePending = shown.status === 0 ? parsePending(shown.stdout) : new Map();
  const baseCases = shown.status === 0 ? parsePendingCases(shown.stdout) : new Map();
  const listed = git(['ls-tree', '-r', '--name-only', base, '--', 'test-vectors']);
  if (listed.status !== 0) throw new Error(`git ls-tree ${base} failed`);
  const baseSuites = new Set(
    listed.stdout
      .split('\n')
      .map((path) => /^test-vectors\/([^/]+)\/vectors\.json$/.exec(path)?.[1])
      .filter((suite) => suite !== undefined),
  );
  problems.push(...checkPendingShrinks(head, { pending: basePending, suites: baseSuites }));
  problems.push(...checkPendingCards(head, cards));
  problems.push(
    ...checkPendingCaseShrinks(head, {
      pending: basePending,
      cases: baseCases,
      suites: baseSuites,
    }),
  );
  problems.push(...checkPendingCards({ pending: pendingCaseEntries(head.cases) }, cards));
  const committed = new Set(
    readdirSync(join(root, 'test-vectors'), { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && existsSync(join(root, 'test-vectors', e.name, 'vectors.json')),
      )
      .map((e) => e.name),
  );
  for (const suite of head.pending.keys()) {
    if (!committed.has(suite)) problems.push(`${suite}: pending but has no vector file`);
  }
  for (const [suite, entry] of head.cases) {
    if (!committed.has(suite)) {
      problems.push(`${suite}: has pending cases but no vector file`);
      continue;
    }
    if (head.pending.has(suite)) problems.push(`${suite}: pending as a suite and per case`);
    const file = JSON.parse(
      readFileSync(join(root, 'test-vectors', suite, 'vectors.json'), 'utf8'),
    );
    const ids = new Set(Array.isArray(file.cases) ? file.cases.map((c) => c?.id) : []);
    for (const id of Array.isArray(entry?.ids) ? entry.ids : []) {
      if (!ids.has(id))
        problems.push(`${suite}: pending case ${String(id)} is not in its vector file`);
    }
  }
  console.log(
    `pending suites: ${String(head.pending.size)} here, ${String(basePending.size)} on ${base}; suites with pending cases: ${String(head.cases.size)} here, ${String(baseCases.size)} on ${base}`,
  );
}

if (gate !== undefined) {
  const phases = gate.split(',').filter(Boolean);
  problems.push(...checkPendingGate(head, phases, cards));
  problems.push(...checkPendingGate({ pending: pendingCaseEntries(head.cases) }, phases, cards));
}

if (problems.length > 0) {
  console.error('\ncheck-pending FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('check-pending passed');
