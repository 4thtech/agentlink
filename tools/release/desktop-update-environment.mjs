#!/usr/bin/env node
// UPD-3 (IR-UPD-8-1 #2, D-151): GitHub creates an environment that does not exist yet, with NO rules,
// the first time a job names it. So before any job can reach DESKTOP_UPDATE_KEY, a job without a
// secret checks (read-only REST answers, saved by `gh api`) that the environment `desktop-update`
// exists and has:
//   - a required-reviewers rule whose reviewers are exactly the owner, the user `talirezun`
//     (P2-ENV-GUARD: any other reviewer, team or extra person fails; the owner's approval click),
//   - a custom deployment branch policy that allows exactly the branch `main` (nothing else),
//   - `can_admins_bypass: false`.
// It fails closed on anything else. No network, no crypto; it prints fixed sentences only.
//
//   desktop-update-environment.mjs --environment <env.json> --policies <branch-policies.json>
//   (a missing environment: --environment pointing at a file that holds `null`)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export class EnvironmentError extends Error {}

/** The only account allowed to approve a signing run (Tali, the owner). */
export const OWNER_LOGIN = 'talirezun';

const SETUP = 'Owner: set it up as in docs/runbooks/desktop-update-keys.md (RB-23), step 1.';

const fail = (why) => {
  throw new EnvironmentError(`The environment desktop-update ${why}. Nothing is signed. ${SETUP}`);
};

/**
 * `env`: GET /repos/{owner}/{repo}/environments/desktop-update (or null when it does not exist).
 * `policies`: GET …/environments/desktop-update/deployment-branch-policies.
 */
export function checkEnvironment(env, policies) {
  if (env === null || typeof env !== 'object' || env.name !== 'desktop-update') {
    fail('does not exist');
  }
  if (env.can_admins_bypass !== false) fail('lets administrators bypass its rules');
  const rules = Array.isArray(env.protection_rules) ? env.protection_rules : [];
  const reviewers = rules.find((r) => r?.type === 'required_reviewers');
  if (!reviewers || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length < 1) {
    fail('has no required reviewer');
  }
  // P2-ENV-GUARD: every reviewer must be the owner's user account (not a team, not another person).
  const onlyOwner = reviewers.reviewers.every(
    (entry) =>
      entry?.type === 'User' &&
      typeof entry.reviewer?.login === 'string' &&
      entry.reviewer.login.toLowerCase() === OWNER_LOGIN,
  );
  if (!onlyOwner) fail(`has a required reviewer who is not ${OWNER_LOGIN}`);
  const branch = env.deployment_branch_policy;
  if (
    branch === null ||
    typeof branch !== 'object' ||
    branch.custom_branch_policies !== true ||
    branch.protected_branches !== false
  ) {
    fail('is not limited to the branch main');
  }
  const list = Array.isArray(policies?.branch_policies) ? policies.branch_policies : [];
  if (
    list.length !== 1 ||
    list[0]?.name !== 'main' ||
    (list[0]?.type !== undefined && list[0].type !== 'branch')
  ) {
    fail('is not limited to the branch main');
  }
}

export function main(argv, { out = (l) => console.log(l) } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { environment: { type: 'string' }, policies: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };
  try {
    checkEnvironment(read(values.environment), read(values.policies));
  } catch (error) {
    out(`::error::${error instanceof EnvironmentError ? error.message : 'Unexpected error.'}`);
    return 1;
  }
  out(
    'The environment desktop-update has talirezun as its only required reviewer, main only, and no admin bypass.',
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    console.log(
      '::error::Usage: desktop-update-environment.mjs --environment <file> --policies <file>',
    );
    process.exitCode = 1;
  }
}
