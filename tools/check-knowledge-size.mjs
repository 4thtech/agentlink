// Size budget for the public knowledge base, run by `pnpm lint` (turbo task `check`) and therefore by CI.
//
// llms.txt and knowledge/*.md are loaded into the website chat's context on every answer, so their
// size costs money. Tokens are estimated as bytes / 4 (a deliberately simple, tokenizer-free method).
//   - above TARGET_TOKENS: a warning (exit 0);
//   - above MAX_TOKENS: a failure (exit 1).
// The folder is deliberately lean: exactly the two files in KNOWLEDGE_FILES (an overview and a user
// guide). A third file fails the check; engineering depth lives in docs-site/technical.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET_TOKENS = 15_000;
export const MAX_TOKENS = 30_000;

/** The only files allowed in knowledge/. */
export const KNOWLEDGE_FILES = ['agentlink-overview.md', 'agentlink-userguide.md'];

/** Returns problems when knowledge/ does not hold exactly KNOWLEDGE_FILES. */
export function checkFileSet(names) {
  const problems = [];
  for (const name of KNOWLEDGE_FILES) {
    if (!names.includes(name)) problems.push(`knowledge/${name} is missing`);
  }
  for (const name of names) {
    if (!KNOWLEDGE_FILES.includes(name)) {
      problems.push(
        `knowledge/${name} is not allowed: fold it into one of ${KNOWLEDGE_FILES.join(' or ')}`,
      );
    }
  }
  return problems;
}

/** Token estimate for a byte count: bytes / 4, rounded up. */
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

/**
 * Evaluates the budget for a list of { path, bytes } entries.
 * Returns { files, total, level } where level is 'ok', 'warn' (above target) or 'fail' (above max).
 */
export function evaluateBudget(entries, target = TARGET_TOKENS, max = MAX_TOKENS) {
  const files = entries.map(({ path, bytes }) => ({ path, tokens: estimateTokens(bytes) }));
  const total = files.reduce((sum, file) => sum + file.tokens, 0);
  const level = total > max ? 'fail' : total > target ? 'warn' : 'ok';
  return { files, total, level };
}

/** Lists llms.txt and every knowledge/*.md under `root`, with their sizes in bytes. */
export function collectEntries(root) {
  const paths = ['llms.txt'];
  const dir = join(root, 'knowledge');
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.md')) paths.push(`knowledge/${name}`);
  }
  return paths.map((path) => ({ path, bytes: statSync(join(root, path)).size }));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const setProblems = checkFileSet(readdirSync(join(root, 'knowledge')));
  if (setProblems.length > 0) {
    for (const problem of setProblems) console.error(`check-knowledge-size: ${problem}`);
    process.exit(1);
  }
  const { files, total, level } = evaluateBudget(collectEntries(root));
  for (const file of files) {
    console.log(`  ${String(file.tokens).padStart(6)} tokens  ${file.path}`);
  }
  const summary = `check-knowledge-size: ${total} tokens (bytes/4), target ${TARGET_TOKENS}, hard max ${MAX_TOKENS}.`;
  if (level === 'fail') {
    console.error(`${summary} Over the hard max: tighten the knowledge base.`);
    process.exit(1);
  }
  if (level === 'warn') {
    console.warn(`${summary} Warning: above the target; tighten rather than grow.`);
    return;
  }
  console.log(`${summary} OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
