// DOCS-COMPACT-A: the one place that names the documentation roots. Every docs tool (wiki sync,
// knowledge bundle, generators, checks) reads its paths from here, so the Phase B rename
// (docs/foundation -> specs, docs-site -> docs, internal docs -> project) was a one-line change:
// `CURRENT_LAYOUT = 'compact'` (done by DOCS-PHASE-B).
//
// Two layouts exist because the wiki sync must keep regenerating old release tags (legacy layout,
// up to v0.5.11) byte for byte while new tags use the compact layout. detectLayout() picks the layout
// of a source tree from what is on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Paths are repo-relative and posix. `label` is the source name in the wiki's synced header. */
export const LAYOUTS = Object.freeze({
  legacy: Object.freeze({
    name: 'legacy',
    label: 'docs-site',
    guide: 'docs-site/guide',
    technical: 'docs-site/technical',
    assets: 'docs-site/assets',
    templates: 'docs-site/_templates',
    publicReadme: 'docs-site/README.md',
    maintaining: 'docs-site/MAINTAINING.md',
    specs: 'docs/foundation',
    process: 'docs/process',
    runbooks: 'docs/runbooks',
    lessons: 'docs/lessons',
    design: 'docs/design',
    internalReadme: 'docs/README.md',
  }),
  compact: Object.freeze({
    name: 'compact',
    label: 'docs',
    guide: 'docs/guide',
    technical: 'docs/technical',
    assets: 'docs/assets',
    templates: 'docs/_templates',
    publicReadme: 'docs/README.md',
    maintaining: 'docs/MAINTAINING.md',
    specs: 'specs',
    process: 'project/process',
    runbooks: 'project/runbooks',
    lessons: 'project/lessons',
    design: 'project/design',
    internalReadme: 'project/README.md',
  }),
});

/** The layout of this checkout (DOCS-PHASE-B flipped it from 'legacy' with the git mv). */
export const CURRENT_LAYOUT = 'compact';

/** Paths that do not move between layouts. */
export const FIXED = Object.freeze({
  status: 'docs/status.yaml',
  llms: 'llms.txt',
  readme: 'README.md',
  knowledge: 'knowledge',
  bundle: 'agentlink-knowledge.md',
});

/** Private specs (kept in the private ops repo): file name prefixes under any specs root. */
export const PRIVATE_SPEC_NAMES = Object.freeze([
  '01-commercial-brief.md',
  '09-repositories-and-reuse.md',
]);

export const WIKI_URL = 'https://wiki.4thtech.io';
export const REPO_URL = 'https://github.com/4thtech/agentlink';
export const BUNDLE_URL = `${REPO_URL}/releases/latest/download/${FIXED.bundle}`;

/** The full path set for a layout name: the moving roots plus derived pages and the fixed paths. */
export function pathsFor(name = CURRENT_LAYOUT) {
  const l = LAYOUTS[name];
  if (!l) throw new Error(`unknown docs layout "${name}"`);
  return Object.freeze({
    ...l,
    ...FIXED,
    securitySpec: `${l.specs}/04-security-and-crypto.md`,
    decisions: `${l.specs}/decisions`,
    statusPage: `${l.technical}/project/status-and-roadmap.md`,
    threatModelPage: `${l.technical}/concepts/threat-model.md`,
    guideReadme: `${l.guide}/README.md`,
    technicalReadme: `${l.technical}/README.md`,
  });
}

/** The paths of this checkout. */
export const DOCS = pathsFor();

/**
 * The layout of a source tree (a checkout of any release tag): compact when docs/guide/SUMMARY.md
 * exists, legacy when docs-site/guide/SUMMARY.md exists, otherwise an error.
 */
export function detectLayout(srcRoot) {
  for (const name of ['compact', 'legacy']) {
    if (fs.existsSync(path.join(srcRoot, LAYOUTS[name].guide, 'SUMMARY.md'))) return LAYOUTS[name];
  }
  throw new Error(
    `${srcRoot} has neither ${LAYOUTS.compact.guide}/SUMMARY.md nor ${LAYOUTS.legacy.guide}/SUMMARY.md: unknown docs layout`,
  );
}
