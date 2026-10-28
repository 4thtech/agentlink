// CHORE-LOCALUI-EMBED-NONEMPTY: a release-time check that the CLI bundle really embeds the local UI.
// An empty embed would make a published CLI answer the fixed 503 page, so no approval would work in
// the browser. `scripts/check-embedded-ui.mjs` reads the embedded entries from a built
// dist/agentlink.js and fails on a missing index.html, JS or CSS (or an empty one). The release
// workflow runs it in the `pack` job after the build, before anything is published. Dev and test
// runs, where the bundle may be absent, never call it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { embeddedUiProblems, entriesFromBundle } from '../scripts/check-embedded-ui.mjs';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const script = join(packageDir, 'scripts', 'check-embedded-ui.mjs');
const work = mkdtempSync(join(tmpdir(), 'agentlink-embed-check-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const REAL: [string, string][] = [
  ['assets/index-Ab12.css', b64('body{}')],
  ['assets/index-Ab12.js', b64('console.log(1)')],
  ['index.html', b64('<!doctype html>')],
];

/** A stand-in for the built bundle: the define is inlined as a literal. */
const bundleWith = (entries: unknown) =>
  `import x from "node:path";\nconst e = ${JSON.stringify(entries)};\nexport function f() { return localUiAssets(e); }\n`;

let counter = 0;
function run(source: string): { code: number | null; stderr: string } {
  counter += 1;
  const file = join(work, `bundle-${counter}.js`);
  writeFileSync(file, source);
  const r = spawnSync(process.execPath, [script, '--bundle', file], { encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}

describe('embedded local UI check (CHORE-LOCALUI-EMBED-NONEMPTY)', () => {
  it('passes a real embed', () => {
    expect(embeddedUiProblems(REAL)).toEqual([]);
    expect(run(bundleWith(REAL)).code).toBe(0);
  });

  it('fails an empty embed', () => {
    expect(embeddedUiProblems([])).not.toEqual([]);
    const r = run(bundleWith([]));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/index\.html/);
  });

  it('fails when index.html, the JS or the CSS is missing', () => {
    for (const missing of ['index.html', '.js', '.css']) {
      const entries = REAL.filter(([name]) => !name.endsWith(missing));
      expect(embeddedUiProblems(entries)).not.toEqual([]);
      expect(run(bundleWith(entries)).code).toBe(1);
    }
  });

  it('fails an entry with no content', () => {
    const entries = REAL.map(([n, d]) => (n === 'index.html' ? [n, ''] : [n, d])) as [
      string,
      string,
    ][];
    expect(embeddedUiProblems(entries)).not.toEqual([]);
    expect(run(bundleWith(entries)).code).toBe(1);
  });

  it('fails a bundle with no embed literal at all, and a missing file', () => {
    expect(entriesFromBundle('export const a = 1;')).toEqual([]);
    expect(run('export const a = 1;').code).toBe(1);
    const r = spawnSync(process.execPath, [script, '--bundle', join(work, 'nope.js')], {
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
  });

  it('reads the entries back out of a bundle', () => {
    expect(entriesFromBundle(bundleWith(REAL))).toEqual(REAL);
  });
});

describe('the release workflow runs the check (sensitive path .github/**)', () => {
  const workflow = readFileSync(
    join(packageDir, '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  it('runs it in the pack job after the build and before the pack step', () => {
    const pack = workflow.slice(
      workflow.indexOf('\n  pack:\n'),
      workflow.indexOf('\n  publish-next:'),
    );
    const build = pack.indexOf('run: pnpm build');
    const check = pack.indexOf('check-embedded-ui.mjs');
    const packStep = pack.indexOf('changesets/action/pack@');
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(packStep).toBeGreaterThan(check);
  });
});
