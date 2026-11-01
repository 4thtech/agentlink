#!/usr/bin/env node
// OPS-FAST-LANE-2 (owner Decision 54, item 3): the paperwork fills itself in.
//
//   node tools/pr/open-pr.mjs --task OPS-FAST-LANE-2 --summary "what changed and why" [options]
//
// From the branch diff against the base it
//   1. computes the security class and the sensitive paths with review-gate's own rules
//      (tools/pr/classes.mjs, audit-rules.md §2.2);
//   2. adds an empty changeset when a versioned package changed without one (D-43), and a
//      changelog.d stub when tools/release/check-changelog-fragment.mjs would ask for one;
//      both are committed on the branch;
//   3. normalizes the title prefix (pr-hygiene's own title rule);
//   4. writes the PR body from .github/pull_request_template.md with every section filled in
//      (placeholders marked EDIT: that the builder replaces);
//   5. pushes the branch and runs `gh pr create` (never a draft, never auto-merge).
//
// It never fills what only a person can attest: the "Independent review" line, and for S2 the
// "Threat note" and "Tests-first evidence" sections stay empty, so review-gate stays red until
// they are written (S2 review unchanged).
//
// Options:
//   --task <ID>           task ID (default: the leading ID of --title, else the branch name)
//   --summary <text>      one to four sentences for "Task ID & summary" and the stubs
//   --title <text>        PR title text (default: the summary's first sentence)
//   --base <branch>       base branch (default: main; diffed against origin/<base>)
//   --body-file <path>    use this body instead of the generated one
//   --changelog-section <Added|Changed|Fixed|Security|Deprecated|Removed|none>  (default: Changed)
//   --dry-run             print the plan, title and body; write, commit and push nothing
//   --no-push             commit the stubs but do not push or open the PR (prints the body)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateChangelog } from '../release/check-changelog-fragment.mjs';
import { TOOLING_DIRS } from '../release/check-changesets.mjs';
import { parseFragment } from '../release/roll-changelog.mjs';
import { CLASS_NAMES, classifyFiles, repoRoot, titleRule } from './classes.mjs';

const TASK_ID = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-[0-9]+[a-z]?\b|^M[0-9]+-([0-9]+[a-z]?|GATE)\b/;
const BARE_PREFIX = /^(CHORE|DOCS|DEPS)\b[:\s-]*/; // upper case only: "Docs for x" stays
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'none'];

/** Parses `git diff --name-status --no-renames` output into [{ status, path }]. */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
}

/**
 * Normalizes a title to `<ID>: <text>`. An ID pr-hygiene does not know as a prefix (W5-WINDOWS)
 * becomes `CHORE <ID>: <text>`, the repository's convention. A duplicate ID or bare prefix
 * at the start of the text is dropped.
 */
export function normalizeTitle({ task, title, titleRe }) {
  let text = String(title ?? '').trim();
  const id = String(task ?? '').trim();
  if (!id) return text;
  for (;;) {
    const before = text;
    if (text.toUpperCase().startsWith(id.toUpperCase())) text = text.slice(id.length);
    text = text.replace(/^[\s:–—-]+/, '').replace(BARE_PREFIX, '');
    if (text === before) break;
  }
  text = text.trim();
  const head = titleRe.test(id) ? id : `CHORE ${id}`;
  return text ? `${head}: ${text}` : head;
}

/** The task ID: --task, else the title's leading ID, else the branch name. */
export function resolveTask({ task, title, branch }) {
  if (task) return task.trim();
  const fromTitle = TASK_ID.exec(
    String(title ?? '')
      .replace(BARE_PREFIX, '')
      .trim(),
  );
  if (fromTitle) return fromTitle[0];
  const fromBranch = TASK_ID.exec(
    String(branch ?? '')
      .replace(/^[^/]*\//, '')
      .toUpperCase(),
  );
  return fromBranch ? fromBranch[0] : null;
}

/** The nearest workspace package directory of a file (below the root), or null. */
function packageDirOf(cwd, file) {
  const parts = file.split('/');
  for (let n = parts.length - 1; n >= 1; n--) {
    const dir = parts.slice(0, n).join('/');
    if (existsSync(join(cwd, dir, 'package.json'))) return dir;
  }
  return null;
}

function isPrivateTooling(cwd, dir) {
  if (!TOOLING_DIRS.includes(dir)) return false;
  try {
    return JSON.parse(readFileSync(join(cwd, dir, 'package.json'), 'utf8')).private === true;
  } catch {
    return false;
  }
}

const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;

/** True when a versioned workspace package changed and no changeset was added (D-43). */
export function needsChangeset({ cwd, changed }) {
  const live = changed.filter((c) => c.status !== 'D');
  if (live.some((c) => CHANGESET.test(c.path))) return false;
  return changed.some((c) => {
    const dir = packageDirOf(cwd, c.path);
    return dir !== null && !isPrivateTooling(cwd, dir);
  });
}

/** True when check-changelog-fragment.mjs would fail for want of a fragment. */
export function needsFragment({ changed }) {
  return !evaluateChangelog({ changed, unreleasedAdded: 0, pr: {} }).ok;
}

export const changesetStub = ({ task, summary }) => `---\n---\n\n${task}: ${oneLine(summary)}\n`;

export function fragmentStub({ task, summary, section, cls }) {
  if (section === 'none') return `---\nsection: none\n---\n\n${task}: ${oneLine(summary)}\n`;
  return `---\nsection: ${section}\n---\n\n- ${oneLine(summary).replace(/\.$/, '')} (${task}, ${CLASS_NAMES[cls]}).\n`;
}

const oneLine = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const EDIT = 'EDIT:';
const DOC_PATH =
  /^(README\.md|CHANGELOG\.md|docs\/|docs-site\/|knowledge\/|changelog\.d\/)|(^|\/)README\.md$/;
const TEST_PATH = /(\.test\.|\.spec\.|\/__tests__\/|\/test\/)/;
const list = (paths, max = 15) =>
  paths.length <= max
    ? paths.map((p) => `- \`${p}\``).join('\n')
    : `${paths
        .slice(0, max)
        .map((p) => `- \`${p}\``)
        .join('\n')}\n- … and ${paths.length - max} more`;

/** Section content by heading (the template's "## " headings). */
export function sectionContent({ heading, task, summary, verdict, files, stubs }) {
  const paths = [...new Set(files.filter((c) => c.status !== 'D').map((c) => c.path))];
  const { cls, sensitive, sensitivePaths, reviewRequired } = verdict;
  const name = CLASS_NAMES[cls];
  const docs = paths.filter((p) => DOC_PATH.test(p));
  const tests = paths.filter((p) => TEST_PATH.test(p));
  const manifests = paths.filter((p) => /(^|\/)package\.json$/.test(p));
  const h = heading.toLowerCase();
  if (h.startsWith('task id'))
    return `${task}: ${oneLine(summary) || `${EDIT} 2-4 sentences, what changed and why.`}`;
  if (h.startsWith('spec sections'))
    return `${EDIT} the spec sections implemented (e.g. 04 §3.5), or None.`;
  if (h.startsWith('invariants'))
    return `${EDIT} which of I-1 to I-10 this touches and how each holds, or None.`;
  if (h.startsWith('tests added')) {
    return tests.length > 0 ? list(tests) : `${EDIT} the tests added, or why none are needed.`;
  }
  if (h.startsWith('docs / spec')) return docs.length > 0 ? list(docs) : 'None';
  if (h.startsWith('docs impact')) {
    return docs.length > 0
      ? list(docs)
      : `none: ${EDIT} the reason (for example "internal refactor, no behaviour change")`;
  }
  if (h.startsWith('dependencies')) {
    return manifests.length > 0
      ? `${EDIT} package.json changed (${manifests.map((p) => `\`${p}\``).join(', ')}): name each dependency added with version, why, license; or None.`
      : 'None';
  }
  if (h.startsWith('independent review')) {
    // The exact marker tools/orchestrator/record-ir.py replaces with the IR line.
    if (reviewRequired) return 'Pending (orchestrator).';
    return `Not required: ${name} outside the sensitive paths (owner Decision 54).`;
  }
  if (h.startsWith('threat note')) {
    // S2 needs a full threat note written by the author; leave it empty so review-gate asks for it.
    if (cls === 2) return '';
    return cls === 1
      ? `${EDIT} short threat note: untrusted inputs touched, checklist items, tests covering them.`
      : 'N/A (S0)';
  }
  if (h.startsWith('tests-first')) {
    // S2: the RED commit SHA, command and output excerpt (audit-rules.md §3.4). Never generated.
    return cls === 2 ? '' : `N/A (${name})`;
  }
  if (h.startsWith('open questions')) return 'None';
  if (h.startsWith('review requirements')) {
    const lines = [
      `Computed class: **${name}**${
        sensitive
          ? ` on sensitive paths (${sensitivePaths
              .slice(0, 5)
              .map((p) => `\`${p}\``)
              .join(', ')}${sensitivePaths.length > 5 ? ', …' : ''})`
          : ''
      }.`,
      reviewRequired
        ? 'Independent review required; merge after CI, the review and Tali\'s "merge" in chat (record it here).'
        : 'No independent review and no go-ahead needed: auto-merge when the checks are green.',
    ];
    if (stubs.length > 0)
      lines.push(`Generated: ${stubs.map((p) => `\`${p}\``).join(', ')} (edit if needed).`);
    return lines.join('\n');
  }
  return null; // keep the template's own content (Security class boxes, Checklist)
}

/** Ticks exactly the computed class in the template's Security class boxes. */
function tickClass(lines, cls) {
  return lines.map((l) => {
    const m = /^(\s*[-*+]\s+)\[[ xX]\](\s*[*_`]*S([012])\b.*)$/.exec(l);
    if (!m) return l;
    return `${m[1]}[${Number(m[3]) === cls ? 'x' : ' '}]${m[2]}`;
  });
}

/** The PR body: the template's headings, comments dropped, every section filled. */
export function buildBody({ template, task, summary, verdict, files, stubs = [] }) {
  const text = template.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->\n?/g, '');
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const generated = sectionContent({
      heading: current.heading,
      task,
      summary,
      verdict,
      files,
      stubs,
    });
    let lines = generated === null ? current.lines : [generated];
    if (/^security class\b/i.test(current.heading)) lines = tickClass(current.lines, verdict.cls);
    out.push(`## ${current.heading}`, ...trim(lines), '');
  };
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = { heading: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return `${out.join('\n').trim()}\n`;
}

function trim(lines) {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

function run(cmd, args, { cwd = repoRoot, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r;
}

export function parseArgs(argv) {
  const opts = { base: 'main', changelogSection: 'Changed', dryRun: false, push: true };
  const value = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-push') opts.push = false;
    else if (a === '--task') opts.task = value(i++);
    else if (a === '--summary') opts.summary = value(i++);
    else if (a === '--title') opts.title = value(i++);
    else if (a === '--base') opts.base = value(i++);
    else if (a === '--body-file') opts.bodyFile = value(i++);
    else if (a === '--changelog-section') opts.changelogSection = value(i++);
    else throw new Error(`unknown option ${a}`);
  }
  if (!SECTIONS.includes(opts.changelogSection)) {
    throw new Error(`--changelog-section must be one of ${SECTIONS.join(', ')}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(opts.base)) throw new Error('--base: not a branch name');
  return opts;
}

/** Computes everything without side effects. */
export function plan({ cwd, opts, changed, branch, template, titleRe }) {
  const task = resolveTask({ task: opts.task, title: opts.title, branch });
  if (!task)
    throw new Error('No task ID: pass --task <ID> (docs/process/backlog.md: no task ID, no work).');
  const summary = oneLine(opts.summary ?? opts.title ?? '');
  const title = normalizeTitle({
    task,
    title: opts.title ?? summary.split(/(?<=\.)\s/)[0].replace(/\.$/, ''),
    titleRe,
  });
  const paths = changed.map((c) => c.path);
  const verdict = classifyFiles(paths);
  const stubs = [];
  const writes = [];
  if (needsChangeset({ cwd, changed })) {
    const path = `.changeset/${task.toLowerCase()}.md`;
    writes.push({ path, text: changesetStub({ task, summary }) });
  }
  if (needsFragment({ changed })) {
    const path = `changelog.d/${task}.md`;
    const text = fragmentStub({ task, summary, section: opts.changelogSection, cls: verdict.cls });
    parseFragment({ name: path, text }); // the stub must pass the release check
    writes.push({ path, text });
  }
  for (const w of writes) {
    if (existsSync(join(cwd, w.path)))
      throw new Error(`${w.path} exists but is not committed; commit or remove it.`);
    stubs.push(w.path);
  }
  const files = [...changed, ...writes.map((w) => ({ status: 'A', path: w.path }))];
  const body = buildBody({
    template,
    task,
    summary,
    verdict: classifyFiles(files.map((c) => c.path)),
    files,
    stubs,
  });
  return { task, title, summary, verdict, writes, body };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = repoRoot;
  const base = `origin/${opts.base}`;
  run('git', ['fetch', '--quiet', 'origin', opts.base], { allowFail: true });
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (branch === opts.base || branch === 'HEAD')
    throw new Error(`Run on a task branch, not ${branch}.`);
  const dirty = run('git', ['status', '--porcelain']).stdout.trim();
  if (dirty && !opts.dryRun)
    throw new Error('The working tree has uncommitted changes; commit them first.');
  const changed = parseNameStatus(
    run('git', ['diff', '--name-status', '--no-renames', `${base}...HEAD`]).stdout,
  );
  if (changed.length === 0) throw new Error(`No changes against ${base}.`);
  const template = readFileSync(join(cwd, '.github/pull_request_template.md'), 'utf8');
  const p = plan({ cwd, opts, changed, branch, template, titleRe: titleRule() });
  const body = opts.bodyFile ? readFileSync(opts.bodyFile, 'utf8') : p.body;

  console.log(
    `Task ${p.task} · class ${p.verdict.name}${p.verdict.sensitive ? ' (sensitive paths)' : ''} · independent review ${p.verdict.reviewRequired ? 'required' : 'not required'}`,
  );
  for (const w of p.writes) console.log(`${opts.dryRun ? 'Would add' : 'Adding'} ${w.path}`);
  console.log(`Title: ${p.title}`);
  if (opts.dryRun) {
    console.log(`\n${body}`);
    return;
  }
  if (p.writes.length > 0) {
    for (const w of p.writes) writeFileSync(join(cwd, w.path), w.text);
    run('git', ['add', '--', ...p.writes.map((w) => w.path)]);
    run('git', ['commit', '--quiet', '-m', `${p.task}: changeset and changelog stubs`]);
  }
  const dir = mkdtempSync(join(tmpdir(), 'open-pr-'));
  const bodyPath = join(dir, 'body.md');
  writeFileSync(bodyPath, body);
  if (!opts.push) {
    console.log(`Body written to ${bodyPath}; not pushed (--no-push).`);
    return;
  }
  run('git', ['push', '--quiet', '-u', 'origin', 'HEAD']);
  const r = run('gh', [
    'pr',
    'create',
    '--base',
    opts.base,
    '--head',
    branch,
    '--title',
    p.title,
    '--body-file',
    bodyPath,
  ]);
  console.log(r.stdout.trim());
  console.log(
    'Replace every "EDIT:" placeholder (gh pr edit), and for S2 fill the Threat note and Tests-first evidence.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`open-pr: ${error?.message ?? String(error)}`);
    process.exit(1);
  });
}
