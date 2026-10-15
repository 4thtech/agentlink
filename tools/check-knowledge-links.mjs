// Link check for the public knowledge base, run by `pnpm lint` (turbo task `check`) and therefore by CI.
//
// For llms.txt and every knowledge/*.md:
//   - a relative link must resolve to an existing path in the repository;
//   - an absolute link into this repository (github.com/4thtech/agentlink/blob|tree/main/...) must
//     point to an existing path;
//   - other external links are not fetched (no network in CI checks);
//   - the placeholder `TBD: wiki link after redesign` is allowed and counted.
// Links inside fenced code blocks are ignored.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'TBD: wiki link after redesign';
const REPO_PREFIX = /^https:\/\/github\.com\/4thtech\/agentlink\/(?:blob|tree)\/main\/([^#?\s]*)/;

/** Returns the link targets of a Markdown text, ignoring fenced code blocks. */
export function extractLinks(text) {
  const withoutCode = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  return [...withoutCode.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

/** Counts the wiki placeholders in a text. */
export function countPlaceholders(text) {
  return text.split(PLACEHOLDER).length - 1;
}

/**
 * Checks the links of one file. `file` is the repo-relative path (posix); `exists(path)` tells
 * whether a repo-relative path exists. Returns a list of problems.
 */
export function checkLinks(file, text, exists) {
  const problems = [];
  for (const target of extractLinks(text)) {
    const repoMatch = REPO_PREFIX.exec(target);
    let path;
    if (repoMatch) {
      path = decodeURIComponent(repoMatch[1]).replace(/\/$/, '');
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
      continue; // another site, mailto:, or a same-page anchor
    } else {
      const bare = decodeURIComponent(target.split(/[#?]/)[0]);
      path = posix.normalize(posix.join(posix.dirname(file), bare)).replace(/\/$/, '');
    }
    if (path === '' || path === '.') continue; // the repository root
    if (path.startsWith('..') || !exists(path)) {
      problems.push(`${file}: link target does not exist: ${target}`);
    }
  }
  return problems;
}

function knowledgeFiles(root) {
  const names = readdirSync(join(root, 'knowledge'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  return ['llms.txt', ...names.map((name) => `knowledge/${name}`)];
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exists = (path) => existsSync(join(root, path));
  const problems = [];
  let placeholders = 0;
  let links = 0;
  for (const file of knowledgeFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    links += extractLinks(text).length;
    placeholders += countPlaceholders(text);
    problems.push(...checkLinks(file, text, exists));
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check-knowledge-links: ${problems.length} broken link(s).`);
    process.exit(1);
  }
  console.log(
    `check-knowledge-links: ${links} links OK; ${placeholders} wiki placeholder(s) ("${PLACEHOLDER}").`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
