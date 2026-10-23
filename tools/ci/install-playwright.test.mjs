// CHORE-CI-PLAYWRIGHT-2: policy tests for the Playwright install action and its callers.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const action = readFileSync(join(root, '.github/actions/install-playwright/action.yml'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

// The text of one `- name:` step of the composite action.
function step(name) {
  const parts = action.split(/\n {4}- name: /).slice(1);
  const found = parts.find((p) => p.startsWith(name));
  if (!found) throw new Error(`no step "${name}"`);
  return found;
}

describe('install-playwright action', () => {
  it('caches the browser downloads with a pinned actions/cache keyed on OS, exact version and list', () => {
    expect(action).toMatch(/uses: actions\/cache@[0-9a-f]{40} # v/);
    expect(action).toContain('path: ~/.cache/ms-playwright');
    expect(action).toMatch(
      /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ inputs\.browsers \}\}/,
    );
  });

  it('never restores a cache from a looser key', () => {
    expect(action).not.toContain('restore-keys');
  });

  it('fails when the version cannot be resolved instead of caching under "unknown"', () => {
    const s = step('Resolve the Playwright version');
    expect(s).toContain('exit 1');
    expect(s).not.toContain('"unknown"');
  });

  it('downloads browsers without apt (no --with-deps on the download step)', () => {
    const dl = step('Download the Playwright browsers');
    expect(dl).toMatch(/playwright install \$BROWSERS/);
    expect(dl).not.toContain('--with-deps');
    expect(dl).toContain('timeout 300');
  });

  it('touches apt only when a system library is missing, bounded and retried', () => {
    const probe = step("Check the browsers' system libraries");
    expect(probe).toContain('probe.mjs');
    expect(probe).not.toContain('ldd');
    expect(probe).toContain('GITHUB_OUTPUT');
    const deps = step('Install the Playwright system libraries (attempt 1)');
    expect(deps).toContain('playwright install-deps');
    expect(deps).toContain('timeout 300');
    expect(deps).toContain("steps.libs.outputs.missing == 'true'");
    const retry = step('Install the Playwright system libraries (attempt 2)');
    expect(retry).toContain("steps.libs.outputs.missing == 'true'");
    expect(retry).toContain("steps.deps1.outcome == 'failure'");
    expect(retry).toContain('apt-get update');
  });

  it('no longer runs `install --with-deps`, and run: blocks hold no inline expressions', () => {
    expect(action).not.toMatch(/playwright install --with-deps/);
    const runBlocks = action
      .split(/\n {6}run: /)
      .slice(1)
      .map((b) => b.split(/\n {4}- name: /)[0]);
    for (const b of runBlocks) expect(b).not.toContain('${{');
  });
});

describe("probe.mjs (Playwright's own host validation)", () => {
  const probe = join(root, '.github/actions/install-playwright/probe.mjs');
  const run = (browsers) =>
    spawnSync(process.execPath, [probe], {
      cwd: root,
      env: { ...process.env, BROWSERS: browsers },
      encoding: 'utf8',
    });

  it('launches through the playwright API, not ldd, and passes with nothing to check', () => {
    expect(readFileSync(probe, 'utf8')).toMatch(/\.launch\(/);
    const r = run('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  it('fails towards installing the libraries on an unknown browser', () => {
    const r = run('nosuchbrowser');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('unknown browser');
  });
});

describe('ci.yml callers', () => {
  it('names the browsers each job installs explicitly', () => {
    const uses = [
      ...ci.matchAll(
        /uses: \.\/\.github\/actions\/install-playwright\n(\s+with:\n\s+browsers: [a-z ]+)?/g,
      ),
    ];
    expect(uses.length).toBe(2);
    for (const m of uses) expect(m[1]).toMatch(/browsers: chromium firefox webkit/);
  });
});
