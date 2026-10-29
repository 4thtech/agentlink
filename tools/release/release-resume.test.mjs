import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// CHORE-RELEASE-HEALTH-TARBALL-WAIT. Incident 0.4.4 (run 40872091202): publish-latest published, the health
// check fetched the tarball while npm's CDN still answered E404 (it waited only for the metadata), so it
// rolled `latest` back and froze; the re-run published nothing and stopped, with no path to finish the
// already-published version. The checks are inline bash in release.yml (the job holds the OIDC token and
// runs no repository code); this test runs the blocks between the TARBALL-WAIT and RESUME markers with
// stub `npm`, `curl` and `sleep` commands, and checks the step order of the publish-latest job.

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
);
const extract = (marker) =>
  (new RegExp(`# ${marker}-BEGIN\\n([\\s\\S]*?)\\s*# ${marker}-END`).exec(workflow)?.[1] ?? '').replace(
    /^ {10}/gm,
    '',
  );
const waitBlock = extract('TARBALL-WAIT');
const resumeBlock = extract('RESUME');

/** A scratch dir with stub commands on PATH. `npm` answers from a JSON table; `curl` from a counter file. */
function sandbox({ registry = {}, curlFailures = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-resume-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry));
  writeFileSync(join(dir, 'curl-failures'), String(curlFailures));
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // npm view <spec> <field>: prints registry[spec][field] or fails (E404) when absent.
  stub(
    'npm',
    `[ "$1" = view ] || exit 2
node -e 'const r=require(process.argv[1]);const v=(r[process.argv[2]]||{})[process.argv[3]];if(v===undefined)process.exit(1);process.stdout.write(String(v)+"\\n")' "${dir}/registry.json" "$2" "$3"`,
  );
  // curl: fails while the counter is above zero; records every URL it was asked for.
  stub(
    'curl',
    `for a in "$@"; do last="$a"; done
echo "$last" >> "${dir}/curl-urls"
n="$(cat "${dir}/curl-failures")"
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${dir}/curl-failures"; exit 22; fi
exit 0`,
  );
  stub('sleep', `echo "$1" >> "${dir}/sleeps"`);
  const read = (f) => {
    try {
      return readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { dir, bin, read };
}

function runWait(box, { budget = 900, args = ['@4thtech-io/agentlink', '0.4.4'] } = {}) {
  const script = `wait_budget=${budget}\nmax_delay=60\n${waitBlock}\nwait_for_tarball "$1" "$2"`;
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script, 'bash', ...args], {
    cwd: box.dir,
    env: { PATH: `${box.bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

describe('tarball wait in the publish-latest health check', () => {
  it('finds the block', () => expect(waitBlock).toContain('wait_for_tarball()'));

  it('retries with backoff until the exact tarball is served', () => {
    const box = sandbox({
      registry: { '@4thtech-io/agentlink@0.4.4': { version: '0.4.4' } },
      curlFailures: 6,
    });
    const r = runWait(box);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tarball served');
    expect(box.read('sleeps')).toEqual(['5', '10', '20', '40', '60', '60']);
    expect(new Set(box.read('curl-urls'))).toEqual(
      new Set(['https://registry.npmjs.org/@4thtech-io/agentlink/-/agentlink-0.4.4.tgz']),
    );
  });

  it('waits for the metadata before fetching the tarball', () => {
    const box = sandbox({ registry: {}, curlFailures: 0 });
    const r = runWait(box, { budget: 0 });
    expect(r.status).toBe(1);
    expect(box.read('curl-urls')).toEqual([]);
  });

  it('fails only after the budget, with a clear error and without logging the URL', () => {
    const box = sandbox({
      registry: { '@4thtech-io/agentlink@0.4.4': { version: '0.4.4' } },
      curlFailures: 1000,
    });
    const r = runWait(box, { budget: 0 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('did not serve the package tarball within 0 seconds');
    expect(r.stdout).not.toContain('registry.npmjs.org');
  });

  it('builds the URL for an unscoped package too', () => {
    const box = sandbox({ registry: { 'plain@1.0.0': { version: '1.0.0' } } });
    expect(runWait(box, { args: ['plain', '1.0.0'] }).status).toBe(0);
    expect(box.read('curl-urls')).toEqual(['https://registry.npmjs.org/plain/-/plain-1.0.0.tgz']);
  });

  it('the health check uses the wait before the provenance and signature checks', () => {
    const step = workflow.slice(workflow.indexOf('# TARBALL-WAIT-END'));
    const loop = step.slice(0, step.indexOf('npm audit signatures'));
    expect(loop.indexOf('wait_for_tarball "$name" "$version"')).toBeGreaterThan(-1);
    expect(loop.indexOf('wait_for_tarball "$name" "$version"')).toBeLessThan(
      loop.indexOf('attestations.provenance'),
    );
    expect(workflow).toMatch(/wait_budget=900\n/);
  });
});

function runResume(box, manifests) {
  for (const [path, json] of Object.entries(manifests)) {
    mkdirSync(join(box.dir, path, '..'), { recursive: true });
    writeFileSync(join(box.dir, path), JSON.stringify(json));
  }
  execFileSync('git', ['init', '-q'], { cwd: box.dir });
  execFileSync('git', ['add', '--', ...Object.keys(manifests)], { cwd: box.dir });
  const script = `${resumeBlock}\nprintf '%s' "$resume"`;
  const r = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: box.dir,
    env: { PATH: `${box.bin}:${process.env.PATH}`, RUNNER_TEMP: box.dir },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return { set: JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('['))), out: r.stdout };
}

describe('re-run of an already-published version (RESUME block)', () => {
  const cli = { 'apps/cli/package.json': { name: '@4thtech-io/agentlink', version: '0.4.4' } };

  it('finds the block', () => expect(resumeBlock).toContain('resume='));

  it('picks a published version whose latest was rolled back (the 0.4.4 case)', () => {
    const box = sandbox({
      registry: {
        '@4thtech-io/agentlink@0.4.4': { version: '0.4.4' },
        '@4thtech-io/agentlink': { 'dist-tags.latest': '0.4.3' },
      },
    });
    expect(runResume(box, cli).set).toEqual([{ name: '@4thtech-io/agentlink', version: '0.4.4' }]);
  });

  it('skips a version that is not published, already latest, older than latest, or deprecated', () => {
    const manifests = {
      'a/package.json': { name: 'not-published', version: '1.0.0' },
      'b/package.json': { name: 'already-latest', version: '1.0.0' },
      'c/package.json': { name: 'older', version: '1.0.0' },
      'd/package.json': { name: 'deprecated', version: '1.0.0' },
      'e/package.json': { name: 'private-one', version: '1.0.0', private: true },
      'f/package.json': { name: 'prerelease', version: '1.0.0-next.1' },
    };
    const box = sandbox({
      registry: {
        'already-latest@1.0.0': { version: '1.0.0' },
        'already-latest': { 'dist-tags.latest': '1.0.0' },
        'older@1.0.0': { version: '1.0.0' },
        older: { 'dist-tags.latest': '1.10.0' },
        'deprecated@1.0.0': { version: '1.0.0', deprecated: 'broken, use 0.9.0' },
        deprecated: { 'dist-tags.latest': '0.9.0' },
        'private-one@1.0.0': { version: '1.0.0' },
        'prerelease@1.0.0-next.1': { version: '1.0.0-next.1' },
      },
    });
    const { set, out } = runResume(box, manifests);
    expect(set).toEqual([]);
    expect(out).toContain('older: latest (1.10.0) is newer than 1.0.0; left alone.');
    expect(out).toContain('deprecated@1.0.0 is deprecated');
  });
});

describe('publish-latest step order and outputs', () => {
  const job = workflow.slice(workflow.indexOf('\n  publish-latest:'), workflow.indexOf('\n  smoke-latest:'));
  const at = (name) => {
    const i = job.indexOf(`- name: ${name}`);
    expect(i, name).toBeGreaterThan(-1);
    return i;
  };

  it('settles the release set, checks, moves latest, rolls back, then creates the GitHub Release', () => {
    const order = [
      'Stop if DEPLOY_FREEZE is set',
      'Record the current latest versions (rollback targets)',
      'Publish to npm (latest, trusted publishing, with provenance)',
      'Settle what this run releases',
      'Health check (tarball served, provenance, signatures, latest updated)',
      'Move latest to the already-published versions (re-run)',
      'Roll latest back to the recorded versions',
      'Create the GitHub Release v<version> from the CHANGELOG',
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the approval environment and hands the release set to the later jobs', () => {
    expect(job).toContain('environment: npm-publish');
    expect(job).toContain('published: ${{ steps.release.outputs.published || steps.publish.outputs.published }}');
    expect(job).toContain(
      'packages: ${{ steps.release.outputs.packages || steps.publish.outputs.published-packages }}',
    );
    expect(job).toMatch(/Move latest[^\n]*\n\s+if: steps\.release\.outputs\.resumed == 'true'/);
    expect(job).toMatch(
      /Roll latest back[^\n]*\n\s+if: failure\(\) && \(steps\.publish\.outputs\.published == 'true' \|\| steps\.release\.outputs\.resumed == 'true'\)/,
    );
    expect(job).toMatch(/Create the GitHub Release[^\n]*\n\s+if: steps\.release\.outputs\.published == 'true'/);
  });
});
