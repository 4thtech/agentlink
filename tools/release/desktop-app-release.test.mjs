import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// WP-D11 (DESK051-C4): release.yml builds the AgentLink desktop app through desktop.yml for the npm
// version just published and attaches it to the GitHub Release under the names the invite page links
// to. Unsigned, updates off until the key ceremony, least privilege, no secret, pinned actions.

const root = resolve(import.meta.dirname, '../..');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const desktop = readFileSync(join(root, '.github/workflows/desktop.yml'), 'utf8');

/** The body of one job: from `  <name>:` to the next job header or the end. */
function job(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

/** The job-level permissions block, one `scope: level` per entry (comments dropped). */
function permissions(body) {
  const m = body.match(/\n {4}permissions:\n((?: {6}[^\n]*\n)+)/);
  if (!m) return [];
  return m[1]
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/#.*$/, '').trim());
}

describe('release.yml desktop app jobs (WP-D11)', () => {
  const build = job(release, 'desktop-app-build');
  const attach = job(release, 'desktop-app-release');

  it('builds through desktop.yml for the published CLI version, unsigned, with updates off', () => {
    expect(build).not.toBe('');
    expect(build).toMatch(/uses: \.\/\.github\/workflows\/desktop\.yml\n/);
    expect(build).toMatch(/version: \$\{\{ needs\.desktop-extension-build\.outputs\.version \}\}/);
    expect(build).toMatch(/updates: "off"/);
    expect(build).not.toMatch(/secrets|environment:|DESKTOP_SIGNING|OWNER_LOCAL/);
    expect(permissions(build).sort()).toEqual([
      'attestations: write',
      'contents: read',
      'id-token: write',
    ]);
  });

  it('attaches only after a green smoke test, honours the freeze, contents: write only, no secret', () => {
    expect(attach).not.toBe('');
    expect(attach).toMatch(/needs\.smoke-latest\.result == 'success'/);
    expect(attach).toMatch(/needs\.desktop-app-build\.result == 'success'/);
    expect(attach).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(attach).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(attach).not.toMatch(/secrets\.|environment:|actions\/checkout/);
    expect(permissions(attach)).toEqual(['contents: write']);
    expect(attach).toMatch(/timeout-minutes: \d+/);
  });

  it('requires the exact DMG names the invite page links to, checks the sums, keeps the extension sums', () => {
    expect(attach).toContain('"AgentLink-$VERSION-mac-arm64.dmg"');
    expect(attach).toContain('"AgentLink-$VERSION-mac-x64.dmg"');
    expect(attach).toContain('"AgentLink-$VERSION-win-x64-setup.exe"');
    expect(attach).toMatch(/sha256sum --check --strict SHA256SUMS-desktop-app\.txt/);
    expect(attach).toMatch(/gh release upload "v\$VERSION" [^\n]*SHA256SUMS-desktop-app\.txt/);
    expect(attach).not.toMatch(/gh release upload [^\n]* SHA256SUMS\s*$/m);
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...`${attach}${desktop}`.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(2);
    for (const use of uses) {
      if (use.startsWith('./')) continue;
      expect(use).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe('desktop.yml release inputs (WP-D11)', () => {
  it('defaults updates to off, validates it, and hands it to the bundle and both builds', () => {
    expect(desktop).toMatch(
      /updates:\n {8}description:[^\n]*\n {8}type: string\n {8}required: false\n {8}default: "off"/,
    );
    expect(desktop).toMatch(/UPDATES: \$\{\{ inputs\.updates \|\| 'off' \}\}/);
    expect(desktop).toMatch(/"\$UPDATES" == "on" \|\| "\$UPDATES" == "off"/);
    expect(desktop).toMatch(
      /AGENTLINK_DESKTOP_UPDATES="\$UPDATES" pnpm --filter @4thtech-io\/desktop run bundle/,
    );
    expect(desktop.match(/--updates "\$UPDATES"/g)).toHaveLength(2);
  });

  it('never references a secret, a signing switch or the owner-local flag', () => {
    expect(desktop).not.toMatch(/secrets\.|DESKTOP_SIGNING: |AGENTLINK_DESKTOP_OWNER_LOCAL_BUILD/);
    expect(desktop).toMatch(/\npermissions: \{\}\n/);
  });

  it('names the artifacts desktop-app-*, so the extension bundles never mix in', () => {
    expect(desktop).toMatch(/name: desktop-app-\$\{\{ matrix\.target \}\}/);
    expect(desktop).toMatch(/pattern: desktop-app-\*/);
    expect(release).toMatch(/pattern: desktop-app-\*/);
  });
});
