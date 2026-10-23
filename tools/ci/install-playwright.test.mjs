// CHORE-CI-PLAYWRIGHT-2, CHORE-CI-PLAYWRIGHT-3: policy tests for the Playwright install action and
// its callers.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  it('restores the browser downloads with a pinned actions/cache keyed on OS, exact version and list', () => {
    const s = step('Restore the Playwright browsers');
    expect(s).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v/);
    expect(s).toContain('path: ~/.cache/ms-playwright');
    expect(s).toMatch(
      /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.version\.outputs\.version \}\}-\$\{\{ inputs\.browsers \}\}/,
    );
  });

  it('never restores the browsers from a looser key', () => {
    expect(step('Restore the Playwright browsers')).not.toContain('restore-keys');
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
  });

  it('touches apt only when a system library is missing, bounded and retried', () => {
    const probe = step("Check the browsers' system libraries");
    expect(probe).toContain('probe.mjs');
    expect(probe).not.toContain('ldd');
    expect(probe).toContain('GITHUB_OUTPUT');
    const deps = step('Install the Playwright system libraries (attempt 1)');
    expect(deps).toContain('playwright install-deps');
    expect(deps).toContain("steps.libs.outputs.missing == 'true'");
    const retry = step('Install the Playwright system libraries (attempt 2)');
    expect(retry).toContain("steps.libs.outputs.missing == 'true'");
    expect(retry).toContain("steps.deps1.outcome == 'failure'");
    expect(retry).toContain('apt-get update');
    // the time limit runs as root (so it can stop root's apt) and hard-kills after a grace period
    expect(deps).toMatch(/sudo -E env "PATH=\$PATH" timeout -k 10 "\$t" /);
    expect(retry).toMatch(/sudo -E env "PATH=\$PATH" timeout -k 10 "\$t" /);
    // mirror fallback on the retry only
    expect(retry).toContain('archive.ubuntu.com');
    expect(deps).not.toContain('archive.ubuntu.com');
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

// CHORE-CI-PLAYWRIGHT-3: the 2026-10-23 timeouts. Every failing run had a browser cache hit and
// then spent the rest of the caller's 12 minutes in apt, downloading WebKit's 181 system packages
// (about 117 MB) from a slow mirror; the inner limits (download 300 s + retry, probe 240 s, apt
// 300 s, update 120 s, apt 300 s) could add up to more than the step's timeout-minutes.
describe('install-playwright time budget (CHORE-CI-PLAYWRIGHT-3)', () => {
  const budgetSh = join(root, '.github/actions/install-playwright/budget.sh');

  it("sets one deadline well inside the callers' timeout-minutes", () => {
    const v = step('Resolve the Playwright version');
    const m = v.match(/BUDGET_SECONDS=(\d+)/);
    expect(m).not.toBeNull();
    const budget = Number(m[1]);
    expect(v).toContain('deadline=');
    const limits = [
      ...ci.matchAll(/timeout-minutes: (\d+)\n\s+uses: \.\/\.github\/actions\/install-playwright/g),
    ];
    expect(limits.length).toBe(2);
    // at least 3 minutes for what the action cannot bound itself (cache restores, saves, kill grace)
    for (const l of limits) expect(budget + 180).toBeLessThanOrEqual(Number(l[1]) * 60);
  });

  it('bounds every network sub-step by the shared deadline, not by fixed limits', () => {
    for (const name of [
      'Download the Playwright browsers',
      "Check the browsers' system libraries",
      'Seed the verified system packages',
      'Install the Playwright system libraries (attempt 1)',
      'Install the Playwright system libraries (attempt 2)',
    ]) {
      const s = step(name);
      expect(s, name).toContain('DEADLINE: ${{ steps.version.outputs.deadline }}');
      expect(s, name).toMatch(/"\$BUDGET" \d+/);
      expect(s, name).not.toMatch(/timeout (-k \d+ )?\d{2,}/);
    }
  });

  it('caps the cache downloads so a slow cache cannot hold the step', () => {
    for (const name of ['Restore the Playwright browsers', 'Restore the system packages']) {
      expect(step(name), name).toContain("SEGMENT_DOWNLOAD_TIMEOUT_MINS: '1'");
    }
  });

  const run = (cap, deadline) =>
    spawnSync('bash', [budgetSh, String(cap)], {
      env: { ...process.env, DEADLINE: deadline === undefined ? '' : String(deadline) },
      encoding: 'utf8',
    });
  const now = () => Math.floor(Date.now() / 1000);

  it('budget.sh gives the cap while time is left, else what is left', () => {
    expect(run(60, now() + 500).stdout.trim()).toBe('60');
    const left = Number(run(240, now() + 100).stdout.trim());
    expect(left).toBeGreaterThanOrEqual(95);
    expect(left).toBeLessThanOrEqual(100);
  });

  it('budget.sh fails with a clear message when the budget is used up', () => {
    const r = run(60, now() + 5);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('time budget');
  });

  it('budget.sh falls back to the cap without a valid deadline, and rejects a bad cap', () => {
    expect(run(90, undefined).stdout.trim()).toBe('90');
    expect(run(90, 'soon').stdout.trim()).toBe('90');
    expect(run('0', now() + 500).status).not.toBe(0);
    expect(run('x', now() + 500).status).not.toBe(0);
  });
});

describe('install-playwright caches: saved from main only (CHORE-CI-PLAYWRIGHT-3)', () => {
  const MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

  it('uses only the split restore/save actions, so no pull request run saves', () => {
    expect(action).not.toMatch(/uses: actions\/cache@/);
    const saves = action
      .split(/\n {4}- name: /)
      .filter((p) => p.includes('uses: actions/cache/save@'));
    expect(saves.length).toBe(2);
    for (const s of saves) {
      expect(s).toMatch(/uses: actions\/cache\/save@[0-9a-f]{40} # v/);
      expect(s).toContain(MAIN);
      expect(s).toContain('continue-on-error: true');
    }
  });

  it('keys the system packages on the runner image and the Playwright version', () => {
    const v = step('Resolve the Playwright version');
    expect(v).toContain('ImageOS');
    expect(v).toContain('ImageVersion');
    const r = step('Restore the system packages');
    expect(r).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v/);
    expect(r).toContain('key: ${{ steps.version.outputs.debs_key }}');
    expect(r).toContain('restore-keys: ${{ steps.version.outputs.debs_prefix }}');
    expect(r).toContain("steps.libs.outputs.missing == 'true'");
  });

  it('lets cached packages reach apt only through the signed-index hash check', () => {
    const seed = step('Seed the verified system packages');
    expect(seed).toContain('apt-get update');
    expect(seed).toContain('verify-debs.sh');
    expect(seed).toContain('continue-on-error: true');
    // never install a cached file directly (that would skip apt's signature chain)
    expect(action).not.toMatch(/dpkg -i|apt(-get)? install[^\n]*\.deb/);
  });

  it('collects the packages only after a successful install on main', () => {
    const c = step('Keep the system packages for the cache');
    expect(c).toContain(MAIN);
    expect(c).toContain("steps.deps1.outcome == 'success' || steps.deps2.outcome == 'success'");
    expect(step('Bound the apt network waits')).toContain('Keep-Downloaded-Packages');
  });
});

describe('verify-debs.sh (cached packages checked against the signed index)', () => {
  const verify = join(root, '.github/actions/install-playwright/verify-debs.sh');
  const good = 'a'.repeat(64);

  // Stubs: dpkg-deb reads "<src>/<name>.fields", sha256sum prints the file's first line as its hash,
  // apt-cache prints the SHA256 that index.txt lists for "<pkg>=<ver>".
  function setup(files, index) {
    const dir = mkdtempSync(join(tmpdir(), 'chore-ci-playwright-3-'));
    const bin = join(dir, 'bin');
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    for (const d of [bin, src, dest]) mkdirSync(d);
    const stub = (name, body) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // verify-debs.sh reads the copy ("<name>.agentlink-partial" in dest); the fields sit in src.
    stub(
      'dpkg-deb',
      `b="$(basename "\${2%.agentlink-partial}")"; grep "^$3=" "${src}/$b.fields" | cut -d= -f2-`,
    );
    stub(
      'sha256sum',
      'for f in "$@"; do [ "$f" = -- ] && continue; printf "%s  %s\\n" "$(head -n1 "$f")" "$f"; done',
    );
    stub(
      'apt-cache',
      `grep -F "$2 " "${join(dir, 'index.txt')}" | awk '{print "SHA256: " $2}'; true`,
    );
    writeFileSync(join(dir, 'index.txt'), index.map((l) => `${l}\n`).join(''));
    for (const [name, hash, fields] of files) {
      writeFileSync(join(src, name), `${hash}\n`);
      writeFileSync(join(src, `${name}.fields`), fields);
    }
    const r = spawnSync('bash', [verify, src, dest], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    const seeded = readdirSync(dest).sort();
    rmSync(dir, { recursive: true, force: true });
    return { r, seeded };
  }

  it('seeds a package whose hash matches the index for that exact version', () => {
    const { r, seeded } = setup(
      [['libfoo1_1.0-1_amd64.deb', good, 'Package=libfoo1\nVersion=1.0-1\n']],
      [`libfoo1=1.0-1 ${good}`],
    );
    expect(r.status).toBe(0);
    expect(seeded).toEqual(['libfoo1_1.0-1_amd64.deb']);
    expect(r.stdout).toContain('seeded=1');
  });

  it('leaves out a package with a different hash, an unknown version or an odd name', () => {
    const { r, seeded } = setup(
      [
        ['libbad1_1.0_amd64.deb', 'b'.repeat(64), 'Package=libbad1\nVersion=1.0\n'],
        ['libold1_0.9_amd64.deb', good, 'Package=libold1\nVersion=0.9\n'],
        ['-rf.deb', good, 'Package=libfoo1\nVersion=1.0-1\n'],
        ['libopt1_1.0_amd64.deb', good, 'Package=-o\nVersion=1.0\n'],
      ],
      [`libbad1=1.0 ${good}`, `libold1=1.0 ${good}`, `libfoo1=1.0-1 ${good}`, `-o=1.0 ${good}`],
    );
    expect(r.status).toBe(0);
    expect(seeded).toEqual([]);
    expect(r.stdout).toContain('seeded=0');
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

  it('names only the failing browsers, and no list at all when the cause is unclear', () => {
    const src = readFileSync(probe, 'utf8');
    expect(src).toContain('failing=');
    const deps = readFileSync(join(root, '.github/actions/install-playwright/action.yml'), 'utf8');
    expect(deps.match(/BROWSERS: \$\{\{ steps\.libs\.outputs\.failing \}\}/g)?.length).toBe(2);
    expect(deps).toContain('echo "failing=$failing" >> "$GITHUB_OUTPUT"');
    // unknown name: unclear, so no failing= line and the caller keeps the full list
    expect(run('nosuchbrowser').stdout).not.toContain('failing=');
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
