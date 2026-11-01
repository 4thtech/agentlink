// OPS-FAST-LANE-2 (owner Decision 54): the security class of a change, computed from its paths.
//
// One copy of the rules: the marked block in .github/workflows/review-gate.yml (audit-rules.md §2.2).
// review-gate runs it inline, because it checks out nothing and must not run code from the PR's
// branch; this module lifts the same block out of the workflow text, so `open-pr.mjs` and the tests
// classify exactly as the gate does. The pr-hygiene title rule is lifted the same way.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLASS_NAMES = ['S0', 'S1', 'S2'];

const BEGIN = '// BEGIN path-classes';
const END = '// END path-classes';

/** Builds { RULES, SENSITIVE, classify, isSensitive } from review-gate.yml's marked block. */
export function loadRules(workflowText) {
  const start = workflowText.indexOf(BEGIN);
  const end = workflowText.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'review-gate.yml: the "BEGIN path-classes" / "END path-classes" block is missing.',
    );
  }
  const block = workflowText.slice(start, end);
  // The block is repository code (a sensitive path), never PR text from the API.
  return new Function(`${block}\nreturn { RULES, SENSITIVE, classify, isSensitive };`)();
}

/** The pr-hygiene title rule (`const TITLE_RE = /.../;`). */
export function loadTitleRule(workflowText) {
  const m = /^\s*const TITLE_RE = (\/.+\/[a-z]*);\s*$/m.exec(workflowText);
  if (!m) throw new Error('pr-hygiene.yml: no `const TITLE_RE = /.../;` line.');
  return new Function(`return ${m[1]};`)();
}

let cached;
function rules() {
  cached ??= loadRules(readFileSync(join(repoRoot, '.github/workflows/review-gate.yml'), 'utf8'));
  return cached;
}

export const classify = (path) => rules().classify(path);
export const isSensitive = (path) => rules().isSensitive(path);

/**
 * Classifies a change. `files` are repository-relative paths (for a rename, pass both names).
 * Returns { cls: 0|1|2, name, sensitive, sensitivePaths, reviewRequired }.
 */
export function classifyFiles(files) {
  let cls = 0;
  const sensitivePaths = [];
  for (const path of files) {
    cls = Math.max(cls, classify(path));
    if (isSensitive(path)) sensitivePaths.push(path);
  }
  const sensitive = sensitivePaths.length > 0;
  return {
    cls,
    name: CLASS_NAMES[cls],
    sensitive,
    sensitivePaths,
    reviewRequired: cls === 2 || sensitive,
  };
}

export function titleRule() {
  return loadTitleRule(readFileSync(join(repoRoot, '.github/workflows/pr-hygiene.yml'), 'utf8'));
}
