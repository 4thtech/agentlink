import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTree,
  isPreviewVersion,
  PREVIEW_BRANCH,
  PREVIEW_TAG,
  preparePlan,
  verifyPackedPlan,
} from './next-preview.mjs';

// W4-NEXT-PREVIEW (owner Decision 44 A1): every green state of the `wave-4` integration branch is
// published to npm `next` as a Changesets snapshot (`x.y.z-next.wave4.<UTC datetime>`), never to
// `latest`, never with a GitHub Release, from the `npm-next` environment with provenance. Nothing
// the preview lane computes is committed, so no pre-mode file or snapshot version can reach `main`.

const root = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'next-preview.mjs');
const SNAPSHOT = '0.4.5-next.wave4.20261029152018';

const entry = (overrides = {}) => ({
  kind: 'publish',
  name: '@4thtech-io/agentlink',
  version: SNAPSHOT,
  access: 'public',
  tag: 'latest',
  ...overrides,
});
const planOf = (...chunks) => ({ version: 1, plan: chunks });
const packed = (overrides = {}) =>
  entry({
    tag: 'next',
    tarball: { path: `packages/4thtech-io-agentlink-${SNAPSHOT}.tgz`, integrity: 'sha256-x' },
    ...overrides,
  });

describe('preview version scheme', () => {
  it('accepts the snapshot versions the Changesets config produces', () => {
    expect(isPreviewVersion(SNAPSHOT)).toBe(true);
    expect(isPreviewVersion('1.0.0-next.wave4.20270101000000')).toBe(true);
  });

  it('never matches a stable release or a main pre-mode prerelease (no collision)', () => {
    for (const v of [
      '0.4.5',
      '0.4.6',
      '0.4.5-next.0',
      '0.4.5-next.12',
      '0.4.5-next.wave4',
      '0.4.5-next.wave4.2026102915',
      '0.4.5-next.wave4.20261029152018.1',
      '0.0.0-next-20261029152018',
      '00.4.5-next.wave4.20261029152018',
      ` ${SNAPSHOT}`,
      42,
      undefined,
    ]) {
      expect(isPreviewVersion(v), String(v)).toBe(false);
    }
  });

  it('the Changesets config builds snapshots on the calculated version with the wave4 template', () => {
    const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8'));
    expect(config.snapshot).toEqual({
      useCalculatedVersion: true,
      prereleaseTemplate: '{tag}.wave4.{datetime}',
    });
    expect(PREVIEW_TAG).toBe('next');
    expect(PREVIEW_BRANCH).toBe('wave-4');
  });
});

describe('preparePlan (pack-preview, before packing)', () => {
  it('forces every release onto the next dist-tag', () => {
    const out = preparePlan(
      planOf([entry({ name: '@4thtech-io/types' })], [entry(), entry({ tag: 'next' })]),
    );
    expect(out.version).toBe(1);
    expect(out.plan.flat().map((r) => r.tag)).toEqual(['next', 'next', 'next']);
  });

  it('keeps an empty plan empty (nothing to publish for this commit)', () => {
    expect(preparePlan(planOf()).plan).toEqual([]);
  });

  it('refuses a stable or non-snapshot version (wave-4 never publishes a real release)', () => {
    expect(() => preparePlan(planOf([entry({ version: '0.4.5' })]))).toThrow(/snapshot/);
    expect(() => preparePlan(planOf([entry({ version: '0.4.5-next.3' })]))).toThrow(/snapshot/);
  });

  it('refuses tag-only entries, foreign scopes and malformed plans', () => {
    expect(() =>
      preparePlan(planOf([{ kind: 'tag-only', name: 'x', version: SNAPSHOT }])),
    ).toThrow();
    expect(() => preparePlan(planOf([entry({ name: 'left-pad' })]))).toThrow(/@4thtech-io/);
    expect(() => preparePlan({ version: 2, plan: [] })).toThrow();
    expect(() => preparePlan({ version: 1 })).toThrow();
    expect(() => preparePlan(null)).toThrow();
  });
});

describe('verifyPackedPlan (publish-preview, the job holding the OIDC token)', () => {
  it('returns the packages to publish when every entry is a next snapshot', () => {
    expect(verifyPackedPlan(planOf([packed({ name: '@4thtech-io/types' })], [packed()]))).toEqual([
      { name: '@4thtech-io/types', version: SNAPSHOT },
      { name: '@4thtech-io/agentlink', version: SNAPSHOT },
    ]);
  });

  it('refuses any entry headed for latest or another dist-tag', () => {
    expect(() => verifyPackedPlan(planOf([packed({ tag: 'latest' })]))).toThrow(/next/);
    expect(() => verifyPackedPlan(planOf([packed({ tag: undefined })]))).toThrow(/next/);
    expect(() => verifyPackedPlan(planOf([packed({ tag: 'beta' })]))).toThrow(/next/);
  });

  it('refuses a stable version, a missing tarball, a foreign scope and an empty plan', () => {
    expect(() => verifyPackedPlan(planOf([packed({ version: '0.4.6' })]))).toThrow(/snapshot/);
    expect(() => verifyPackedPlan(planOf([packed({ tarball: undefined })]))).toThrow(/tarball/);
    expect(() => verifyPackedPlan(planOf([packed({ name: 'evil' })]))).toThrow(/@4thtech-io/);
    expect(() => verifyPackedPlan(planOf([{ kind: 'tag-only', name: 'x' }]))).toThrow();
    expect(() => verifyPackedPlan(planOf())).toThrow(/nothing/);
  });
});

function tree({ preJson, versions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w4np-'));
  mkdirSync(join(dir, '.changeset'), { recursive: true });
  writeFileSync(join(dir, '.changeset/config.json'), '{}\n');
  if (preJson) writeFileSync(join(dir, '.changeset/pre.json'), JSON.stringify(preJson));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  for (const [path, version] of Object.entries({ 'apps/cli': '0.4.4', ...versions })) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ name: path, version }));
  }
  mkdirSync(join(dir, 'node_modules/x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/x/package.json'), JSON.stringify({ version: SNAPSHOT }));
  return dir;
}

describe('checkTree (no pre-mode file or snapshot version leaks into main)', () => {
  it('passes a clean tree on both lanes (node_modules is ignored)', () => {
    expect(checkTree({ root: tree(), lane: 'main' })).toEqual([]);
    expect(checkTree({ root: tree(), lane: 'wave-4' })).toEqual([]);
  });

  it('wave-4: refuses .changeset/pre.json in any mode (snapshots only, nothing to exit later)', () => {
    for (const mode of ['pre', 'exit']) {
      const problems = checkTree({
        root: tree({ preJson: { mode, tag: 'next' } }),
        lane: 'wave-4',
      });
      expect(problems.join('\n')).toMatch(/pre\.json/);
    }
  });

  it('main: pre mode with tag next stays a legal channel', () => {
    expect(
      checkTree({ root: tree({ preJson: { mode: 'pre', tag: 'next' } }), lane: 'main' }),
    ).toEqual([]);
  });

  it('both lanes: refuses a committed snapshot version (it would publish to latest from main)', () => {
    for (const lane of ['main', 'wave-4']) {
      const problems = checkTree({ root: tree({ versions: { 'packages/core': SNAPSHOT } }), lane });
      expect(problems.join('\n')).toMatch(/packages\/core\/package\.json/);
    }
  });

  it('refuses an unknown lane', () => {
    expect(() => checkTree({ root: tree(), lane: 'feature' })).toThrow(/lane/);
  });

  it('the command line exits 1 with the problem and 0 on a clean tree', () => {
    const ok = execFileSync('node', [script, 'check-tree', '--lane', 'wave-4', '--root', tree()], {
      encoding: 'utf8',
    });
    expect(ok).toMatch(/clean/);
    let failed;
    try {
      execFileSync(
        'node',
        [script, 'check-tree', '--lane', 'wave-4', '--root', tree({ preJson: { mode: 'pre' } })],
        { stdio: 'pipe' },
      );
    } catch (error) {
      failed = error;
    }
    expect(failed?.status).toBe(1);
    expect(String(failed?.stdout)).toMatch(/::error::.*pre\.json/);
  });

  it('this repository passes on main (the merge of wave-4 into main runs the same check)', () => {
    expect(checkTree({ root, lane: 'main' })).toEqual([]);
  });
});

describe('the command line plan steps', () => {
  it('prepare-plan writes the next-tagged plan; verify-plan prints the packages as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w4np-plan-'));
    writeFileSync(join(dir, 'in.json'), JSON.stringify(planOf([entry()])));
    execFileSync('node', [
      script,
      'prepare-plan',
      '--in',
      join(dir, 'in.json'),
      '--out',
      join(dir, 'out.json'),
    ]);
    const prepared = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    expect(prepared.plan[0][0].tag).toBe('next');
    writeFileSync(join(dir, 'packed.json'), JSON.stringify(planOf([packed()])));
    const out = execFileSync('node', [script, 'verify-plan', '--in', join(dir, 'packed.json')], {
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual([{ name: '@4thtech-io/agentlink', version: SNAPSHOT }]);
  });
});

// ---------------------------------------------------------------------------
// release.yml structure: the preview lane cannot reach `latest`, GitHub Releases or the desktop
// extension, and the main lane never runs for a wave-4 push.

const workflow = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8');
const release = workflow('release.yml');
const jobOf = (source, name) => {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
};
const jobsOf = (source) =>
  [...source.slice(source.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map(
    (m) => m[1],
  );
const needsOf = (job) => {
  const m = /\n {4}needs: (?:\[([^\]]*)\]|(\S+))\n/.exec(job);
  if (!m) return [];
  return (m[1] ?? m[2]).split(',').map((s) => s.trim());
};
const ifOf = (job) => /\n {4}if: ([^\n]*)\n/.exec(job)?.[1] ?? '';
const reaches = (name, target, seen = new Set()) => {
  if (name === target) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  return needsOf(jobOf(release, name)).some((n) => reaches(n, target, seen));
};
const PREVIEW_JOBS = ['pack-preview', 'publish-preview', 'smoke-preview'];

describe('release.yml: triggers', () => {
  it('runs on push to main and wave-4 only (no PR, fork, dispatch or tag trigger)', () => {
    const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(release)?.[1] ?? '';
    expect(on.trim()).toBe('push:\n    branches: [main, wave-4]');
  });

  it('ci-green waits for the push runs of this branch', () => {
    const ciGreen = jobOf(release, 'ci-green');
    expect(ciGreen).toMatch(/--branch "\$BRANCH"/);
    expect(ciGreen).toMatch(/\n {10}BRANCH: \$\{\{ github\.ref_name \}\}\n/);
  });

  it('security.yml runs on push to wave-4 so ci-green can find its gate', () => {
    const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(workflow('security.yml'))?.[1] ?? '';
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main, wave-4\]\n/);
  });

  it('guard refuses leaked pre-mode files or snapshot versions for its lane', () => {
    const guard = jobOf(release, 'guard');
    expect(guard).toMatch(/node tools\/release\/next-preview\.mjs check-tree --lane "\$LANE"/);
  });
});

describe('release.yml: the main lane never runs for a wave-4 push', () => {
  it('select-mode runs only on main', () => {
    expect(ifOf(jobOf(release, 'select-mode'))).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  it('every job outside the preview lane is ci-green, guard or downstream of select-mode', () => {
    for (const name of jobsOf(release)) {
      if (['ci-green', 'guard', 'select-mode', ...PREVIEW_JOBS].includes(name)) continue;
      const job = jobOf(release, name);
      // Jobs with always() still only act on main-lane outputs, which are empty when skipped.
      const onMainLane = needsOf(job).some((n) => reaches(n, 'select-mode'));
      expect(onMainLane, `${name} must depend on the main lane`).toBe(true);
    }
  });

  it('no preview job depends on a main-lane job, and no main-lane job on a preview job', () => {
    for (const name of PREVIEW_JOBS) expect(reaches(name, 'select-mode'), name).toBe(false);
    for (const name of jobsOf(release)) {
      if (PREVIEW_JOBS.includes(name)) continue;
      for (const p of PREVIEW_JOBS) expect(reaches(name, p), `${name} -> ${p}`).toBe(false);
    }
  });
});

describe('release.yml: the preview lane', () => {
  const pack = jobOf(release, 'pack-preview');
  const publish = jobOf(release, 'publish-preview');
  const smoke = jobOf(release, 'smoke-preview');

  it('exists', () => {
    for (const job of [pack, publish, smoke]) expect(job).not.toBe('');
  });

  it('runs only for wave-4 and only after guard', () => {
    expect(needsOf(pack)).toEqual(['guard']);
    expect(ifOf(pack)).toMatch(/needs\.guard\.outputs\.enabled == 'true'/);
    expect(ifOf(pack)).toMatch(/github\.ref == 'refs\/heads\/wave-4'/);
    expect(ifOf(publish)).toMatch(/github\.ref == 'refs\/heads\/wave-4'/);
    expect(ifOf(publish)).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(needsOf(publish)).toEqual(['pack-preview']);
    expect(needsOf(smoke)).toEqual(['publish-preview']);
  });

  it('builds a snapshot without publish rights and forces the next tag', () => {
    expect(pack).toMatch(/\n {4}permissions:\n {6}contents: read[^\n]*\n {4}outputs:/);
    expect(pack).not.toMatch(/id-token/);
    expect(pack).toMatch(/pnpm exec changeset version --snapshot next\n/);
    expect(pack).toMatch(/node tools\/vectors\/check-pending\.mjs --gate M1a/);
    expect(pack).toMatch(/node apps\/cli\/scripts\/check-embedded-ui\.mjs/);
    expect(pack).toMatch(/next-preview\.mjs prepare-plan/);
    expect(pack).toMatch(/pnpm exec changeset pack --from-publish-plan/);
    // Snapshot first, build second: the CLI must embed the version it is published as.
    expect(pack.indexOf('--snapshot next')).toBeLessThan(pack.indexOf('pnpm build'));
  });

  it('publishes from npm-next with provenance, no git tags, no GitHub Release, no custom tag', () => {
    expect(publish).toMatch(/\n {4}environment: npm-next\n/);
    expect(publish).toMatch(
      /\n {4}permissions:\n {6}contents: read[^\n]*\n {6}id-token: write[^\n]*\n {4}[a-z]/,
    );
    expect(publish).not.toMatch(/contents: write/);
    expect(publish).toMatch(/NPM_CONFIG_PROVENANCE: "true"/);
    expect(publish).toMatch(
      /pnpm exec changeset publish --from-pack-dir "\$PACK_DIR" --no-git-tag\n/,
    );
    expect(publish).not.toMatch(/--tag[ =]/);
    expect(publish).not.toMatch(/gh release|create-github-releases/);
    // The packed plan is verified in this job, before the publish step.
    expect(publish.indexOf('next-preview.mjs verify-plan')).toBeGreaterThan(0);
    expect(publish.indexOf('next-preview.mjs verify-plan')).toBeLessThan(
      publish.indexOf('changeset publish --from-pack-dir'),
    );
    expect(publish).toMatch(/Refuse registry overrides/);
    expect(publish).toMatch(/dist-tag next is not/);
    expect(publish).toMatch(/moved latest/);
    expect(publish).toMatch(/no provenance attestation/);
  });

  it('no other job holds npm-publish rights for wave-4 and no preview job uses npm-publish', () => {
    for (const job of [pack, publish, smoke]) {
      expect(job).not.toMatch(/environment: npm-publish/);
      expect(job).not.toMatch(/environment: deploy-freeze/);
    }
    expect(smoke).toMatch(/\n {4}permissions:\n {6}contents: read/);
    expect(smoke).not.toMatch(/id-token/);
  });

  it('every ${{ }} in a preview run block comes in through env', () => {
    for (const job of [pack, publish, smoke]) {
      for (const block of job.matchAll(/\n( +)run: \|[^\n]*\n((?:\1 {2}.*\n|\s*\n)*)/g)) {
        expect(block[2]).not.toMatch(/\$\{\{/);
      }
      for (const line of job.matchAll(/\n +run: (?!\|)([^\n]*)/g)) {
        expect(line[1]).not.toMatch(/\$\{\{/);
      }
    }
  });
});
