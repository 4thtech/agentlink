// Size budget for the public knowledge base, run by `pnpm lint` (turbo task `check`) and therefore by CI.
//
// llms.txt and knowledge/*.md are loaded into the website chat's context on every answer, so their
// size costs money. Tokens are estimated as bytes / 4 (a deliberately simple, tokenizer-free method).
//   - above TARGET_TOKENS: a warning (exit 0);
//   - above MAX_TOKENS: a failure (exit 1).
// The folder is deliberately lean: exactly the files in KNOWLEDGE_FILES, one topic per file (an index,
// the overview, the user guide, the desktop app, the FAQ, security and privacy, the technical
// overview). Lumina reads every file whole, so each must stand alone. Another file fails the check;
// engineering depth lives in docs-site/technical.
//
// Budgets (KNOWLEDGE-1, 2026-11-13): the folder grew from 2 to 7 files, so the total target moves from
// 15,000 to 19,000 tokens (about 76 KB with llms.txt); the hard max stays 30,000. Each file also has a
// hard cap (PER_FILE_MAX_TOKENS) so no single topic grows back into a wall of text.

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET_TOKENS = 19_000;
export const MAX_TOKENS = 30_000;

/** Hard cap for one knowledge file (and llms.txt): the user guide is the largest, about 5,900 tokens. */
export const PER_FILE_MAX_TOKENS = 7_000;

/** The only files allowed in knowledge/. */
export const KNOWLEDGE_FILES = [
  'README.md',
  'agentlink-desktop-app.md',
  'agentlink-faq.md',
  'agentlink-files-and-storage.md',
  'agentlink-overview.md',
  'agentlink-security-and-privacy.md',
  'agentlink-technical-overview.md',
  'agentlink-userguide.md',
];

/** Returns problems when knowledge/ does not hold exactly KNOWLEDGE_FILES. */
export function checkFileSet(names) {
  const problems = [];
  for (const name of KNOWLEDGE_FILES) {
    if (!names.includes(name)) problems.push(`knowledge/${name} is missing`);
  }
  for (const name of names) {
    if (!KNOWLEDGE_FILES.includes(name)) {
      problems.push(
        `knowledge/${name} is not allowed: fold it into one of ${KNOWLEDGE_FILES.join(', ')}`,
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
 * Returns { files, total, level, overCap } where level is 'ok', 'warn' (above target) or 'fail' (above max,
 * or a file above the per-file cap, listed in overCap).
 */
export function evaluateBudget(
  entries,
  target = TARGET_TOKENS,
  max = MAX_TOKENS,
  perFileMax = PER_FILE_MAX_TOKENS,
) {
  const files = entries.map(({ path, bytes }) => ({ path, tokens: estimateTokens(bytes) }));
  const total = files.reduce((sum, file) => sum + file.tokens, 0);
  const overCap = files.filter((file) => file.tokens > perFileMax).map((file) => file.path);
  const level = total > max || overCap.length > 0 ? 'fail' : total > target ? 'warn' : 'ok';
  return { files, total, level, overCap };
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
  const { files, total, level, overCap } = evaluateBudget(collectEntries(root));
  for (const path of overCap) {
    console.error(
      `check-knowledge-size: ${path} is above ${PER_FILE_MAX_TOKENS} tokens; split or tighten it.`,
    );
  }
  for (const file of files) {
    console.log(`  ${String(file.tokens).padStart(6)} tokens  ${file.path}`);
  }
  const summary = `check-knowledge-size: ${total} tokens (bytes/4), target ${TARGET_TOKENS}, hard max ${MAX_TOKENS}.`;
  if (level === 'fail') {
    console.error(`${summary} Over a hard limit: tighten the knowledge base.`);
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
