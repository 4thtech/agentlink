import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, unpublishedOf } from './unpublished.mjs';

// OPS-UNSTICK-A (report R-1, C5): a release whose run was superseded by a feature merge must still
// publish. select-mode picks `version` while any changeset is pending, so the newer run would only
// update the Version packages PR and the versions already on main would never reach npm. The
// select-mode job now also asks Changesets' own publish plan (registry-aware) whether main holds
// versions that npm does not have; if so, the publish path runs in that mode too.

const plan = (...entries) => ({ version: 1, plan: [entries] });
const pub = (name, version) => ({ kind: 'publish', name, version, tag: 'latest' });

describe('unpublishedOf', () => {
  it('lists the entries Changesets would publish, not tag-only ones', () => {
    expect(
      unpublishedOf(
        plan(pub('@4thtech-io/core', '0.5.0'), {
          kind: 'tag-only',
          name: '@4thtech-io/drop',
          version: '0.5.0',
        }),
      ),
    ).toEqual(['@4thtech-io/core@0.5.0']);
    expect(unpublishedOf(plan())).toEqual([]);
  });

  it('refuses a malformed plan (fail closed)', () => {
    for (const bad of [null, {}, { version: 1 }, { version: 1, plan: 'x' }, { plan: [[{}]] }]) {
      expect(() => unpublishedOf(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => unpublishedOf(plan({ kind: 'publish', name: '', version: '1.0.0' }))).toThrow();
  });
});

describe('run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unpublished-'));
  const write = (value) => {
    const file = join(dir, `${Math.random()}.json`);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const go = (argv) => {
    const out = [];
    const code = run({ argv, log: (l) => out.push(l) });
    return { code, out: out.join('\n') };
  };

  it('prints unpublished=true and the list when npm lacks versions on main', () => {
    const r = go(['--plan', write(plan(pub('@4thtech-io/agentlink', '0.4.10')))]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('unpublished=true');
    expect(r.out).toContain('@4thtech-io/agentlink@0.4.10');
  });

  it('prints unpublished=false when everything is on npm', () => {
    const r = go(['--plan', write(plan())]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('unpublished=false');
  });

  it('fails for a missing or broken plan', () => {
    expect(go(['--plan', join(dir, 'missing.json')]).code).toBe(1);
    expect(go(['--plan', write('{')]).code).toBe(1);
    expect(go([]).code).toBe(1);
  });
});

describe('release.yml wiring', () => {
  const release = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
    'utf8',
  );
  const jobOf = (name) => {
    const start = release.indexOf(`\n  ${name}:\n`);
    if (start < 0) return '';
    const rest = release.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 2);
  };
  const ifOf = (job) => /\n {4}if: ([^\n]*)\n/.exec(job)?.[1] ?? '';

  it('select-mode publishes whenever main holds versions npm does not have', () => {
    const select = jobOf('select-mode');
    expect(select).toContain('node tools/release/unpublished.mjs --plan');
    expect(select).toMatch(
      /publish: \$\{\{ steps\.select\.outputs\.mode == 'publish' \|\| steps\.unpublished\.outputs\.unpublished == 'true' \}\}/,
    );
  });

  it('the publish path follows that output, in either mode', () => {
    expect(ifOf(jobOf('pack'))).toMatch(/needs\.select-mode\.outputs\.publish == 'true'/);
    expect(ifOf(jobOf('publish-latest'))).toMatch(/needs\.select-mode\.outputs\.publish == 'true'/);
    expect(ifOf(jobOf('publish-next'))).toMatch(/needs\.select-mode\.outputs\.publish == 'true'/);
    for (const name of ['pack', 'publish-latest', 'publish-next']) {
      expect(ifOf(jobOf(name)), name).not.toMatch(/outputs\.mode == 'publish'/);
    }
  });

  // OPS-UNSTICK-A (report RC-4, C6): the `next` snapshot from main failed with npm 404 in 8 of 17
  // runs (npm allows one trusted publisher per package). Off on main until the owner turns it on.
  it('the main `next` snapshot lane is off unless NEXT_SNAPSHOT_ON_MAIN is true', () => {
    const cond = ifOf(jobOf('pack-preview'));
    expect(cond).toMatch(
      /github\.ref == 'refs\/heads\/main' && vars\.NEXT_SNAPSHOT_ON_MAIN == 'true'/,
    );
    expect(cond).toMatch(/github\.ref == 'refs\/heads\/wave-4'/);
    expect(release).toMatch(/NEXT_SNAPSHOT_ON_MAIN/);
  });
});
