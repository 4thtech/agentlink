#!/usr/bin/env node
// OPS-UNSTICK-A (report R-1, C5): does main hold package versions that npm does not have?
//
// release.yml's select-mode picks `version` while any changeset is pending, and only `publish`
// mode used to run the publish path. A Version packages merge whose own run was superseded (its CI
// cancelled because a feature merge followed) then never published: the feature merge's run was in
// `version` mode. select-mode now also writes Changesets' own publish plan (`changeset
// publish-plan`, which asks the registry) and this prints whether it holds anything to publish; the
// publish path (pack, publish-latest or publish-next, still behind ci-green, DEPLOY_FREEZE and the
// owner's npm-publish click) runs whenever it does.
//
//   node tools/release/unpublished.mjs --plan <publish-plan.json>  >> "$GITHUB_OUTPUT"
//
// Prints `unpublished=true|false` (and the list as a notice). Fails closed on a malformed plan.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** The `name@version` entries a publish plan would publish (tag-only entries are not missing). */
export function unpublishedOf(plan) {
  if (!plan || typeof plan !== 'object' || typeof plan.version !== 'number') {
    throw new Error('malformed publish plan');
  }
  if (!Array.isArray(plan.plan)) throw new Error('malformed publish plan');
  const out = [];
  for (const entry of plan.plan.flat()) {
    if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string') {
      throw new Error('malformed publish plan entry');
    }
    if (entry.kind !== 'publish') continue;
    if (!NAME_RE.test(entry.name ?? '') || !VERSION_RE.test(entry.version ?? '')) {
      throw new Error('malformed publish plan entry');
    }
    out.push(`${entry.name}@${entry.version}`);
  }
  return out;
}

/** The command line. Returns the exit code; prints step output lines. */
export function run({ argv, log = console.log }) {
  try {
    if (argv.length !== 2 || argv[0] !== '--plan') {
      throw new Error('usage: unpublished.mjs --plan <publish-plan.json>');
    }
    const missing = unpublishedOf(JSON.parse(readFileSync(argv[1], 'utf8')));
    log(`unpublished=${missing.length > 0}`);
    if (missing.length > 0) {
      // The notice goes to stderr (the job log); stdout is appended to GITHUB_OUTPUT.
      console.error(
        `::notice::main holds versions npm does not have: ${missing.join(', ')}; the publish path runs.`,
      );
      log(`packages=${JSON.stringify(missing)}`);
    }
    return 0;
  } catch (error) {
    console.error(`::error::Could not read the publish plan: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run({ argv: process.argv.slice(2) });
}
