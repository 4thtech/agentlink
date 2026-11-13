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
    // The build's own sums are checked in full before the release sums are cut down to the DMGs.
    expect(attach).toMatch(/sha256sum --check --strict SHA256SUMS\n/);
    expect(attach).toMatch(/sha256sum --check --strict SHA256SUMS-desktop-app\.txt/);
    expect(attach).toMatch(/is not listed exactly once in SHA256SUMS/);
    // DESK051-C5: the sums file is in the attach list (uploaded, or already there with the same bytes).
    expect(attach).toMatch(/for f in "\$\{files\[@\]\}" SHA256SUMS-desktop-app\.txt; do/);
    expect(attach).toMatch(
      /gh release upload "v\$VERSION" --repo "\$REPOSITORY" -- "\$\{upload\[@\]\}"/,
    );
    expect(attach).not.toMatch(/gh release upload [^\n]* SHA256SUMS\s*$/m);
  });

  // D15-03: a missing release or a missing asset is a red job, never a warning on a green run.
  it('fails when Release v<version> does not exist, and checks what got attached', () => {
    const step = attach.slice(attach.indexOf('Attach the app to the GitHub Release'));
    expect(step).not.toBe('');
    expect(step).not.toMatch(/::warning::/);
    expect(step).toMatch(/gh release view "v\$VERSION"[^\n]*\|\|[^\n]*\n?[^\n]*::error::/);
    expect(step).not.toMatch(/exit 0/);
    // After the upload: every installer name must be on the release.
    expect(step).toMatch(/gh release view "v\$VERSION" [^\n]*--json assets/);
    for (const name of ['mac-arm64.dmg', 'mac-x64.dmg']) {
      expect(step).toContain(`AgentLink-$VERSION-${name}`);
    }
  });

  // REL051-CIE (scope change, 0.5.1): the Windows desktop app is not shipped yet. The release
  // attaches exactly the two Mac DMGs and their sums: no Windows installer, no zip, no glob.
  it('attaches only the two Mac DMGs and SHA256SUMS-desktop-app.txt', () => {
    const step = attach.slice(attach.indexOf('Attach the app to the GitHub Release'));
    expect(step).toContain(
      'files=( "AgentLink-$VERSION-mac-arm64.dmg" "AgentLink-$VERSION-mac-x64.dmg" "AgentLink-mac-arm64.dmg" "AgentLink-mac-x64.dmg" )',
    );
    expect(attach).not.toMatch(/setup\.exe|win-x64|\*\.zip|\*\.dmg/);
    expect(build).not.toMatch(/windows/);
  });

  // D15-10: a re-run never silently replaces a published installer with other bytes.
  it('never clobbers; an existing asset must have the same hash; every uploaded file is in the sums', () => {
    const step = attach.slice(attach.indexOf('Attach the app to the GitHub Release'));
    expect(step).not.toMatch(/--clobber/);
    expect(step).toMatch(/gh release download "v\$VERSION"/);
    expect(step).toMatch(/is not listed in SHA256SUMS-desktop-app\.txt/);
  });

  // REL-LINKS-1: stable names, Latest flipped last, public links checked; REL-HOLD-1: RELEASE_HOLD.
  it('uploads stable-named copies and lists them in the sums', () => {
    expect(attach).toContain('cp -- "AgentLink-$VERSION-mac-$arch.dmg" "AgentLink-mac-$arch.dmg"');
    expect(attach).toMatch(/AgentLink-mac-\$arch\.dmg" >> SHA256SUMS-desktop-app\.txt/);
  });

  it('creates the Release not-Latest and marks it Latest only as the last Release change', () => {
    const create = release.slice(release.indexOf('gh release create "v$VERSION"'));
    expect(create.split('\n')[0]).toContain('--latest=false');
    const flip = attach.indexOf('gh release edit "v$VERSION"');
    expect(flip).toBeGreaterThan(attach.indexOf('gh release upload'));
    expect(attach.slice(flip)).not.toMatch(/gh release (upload|create|delete)/);
    expect(attach.match(/gh release edit/g)).toHaveLength(1);
    expect(attach).toMatch(/gh release edit "v\$VERSION" [^\n]*--latest\n/);
    // never for a prerelease or a draft; the hashes are checked again just before
    expect(attach).toMatch(/--json isPrerelease,isDraft/);
    expect(attach.slice(0, flip)).toMatch(
      /sha256sum --check --strict SHA256SUMS-desktop-app\.txt\n\s+$/,
    );
  });

  it('checks that both public latest/download links answer 200 with a plausible size', () => {
    const check = attach.slice(attach.indexOf('Check the public download links'));
    expect(check).toContain('releases/latest/download/AgentLink-mac-$arch.dmg');
    expect(check).toContain('for arch in arm64 x64');
    expect(check).toMatch(/"\$code" = "200"/);
    expect(check).toMatch(/-gt 20000000/);
  });

  it('RELEASE_HOLD: the Version PR still updates, but auto-merge and pack are off', () => {
    const version = job(release, 'version');
    expect(version).toMatch(/Turn on auto-merge[^\n]*\n\s+if:[^\n]*vars\.RELEASE_HOLD != 'true'/);
    expect(version).toContain('changesets/action/version');
    expect(version).not.toMatch(
      /uses: changesets[^\n]*\n(?:[^\n]*\n){0,3}\s+if:[^\n]*RELEASE_HOLD/,
    );
    expect(job(release, 'pack')).toMatch(/\n {4}if: [^\n]*vars\.RELEASE_HOLD != 'true'/);
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
  // REL051-CIE: the win-x64 leg runs only on a manual run with `windows: true` (boolean, default
  // false); pull requests and workflow_call (the release) build the two Mac targets only.
  it('builds Windows only on a manual run with windows: true', () => {
    const dispatch = desktop.slice(
      desktop.indexOf('  workflow_dispatch:'),
      desktop.indexOf('  pull_request:'),
    );
    expect(dispatch).toMatch(
      /windows:\n {8}description:[^\n]*\n {8}type: boolean\n {8}required: false\n {8}default: false/,
    );
    const call = desktop.slice(
      desktop.indexOf('  workflow_call:'),
      desktop.indexOf('  workflow_dispatch:'),
    );
    expect(call).not.toMatch(/windows/);
    const include = desktop.match(
      /\n {8}include: \$\{\{ fromJSON\(inputs\.windows == true && '(\[.*?\])' \|\| '(\[.*?\])'\) \}\}\n/,
    );
    expect(include).not.toBeNull();
    const withWindows = JSON.parse(include[1]);
    const macOnly = JSON.parse(include[2]);
    expect(macOnly.map((t) => t.target)).toEqual(['mac-arm64', 'mac-x64']);
    expect(withWindows.map((t) => t.target)).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
    expect(macOnly.every((t) => t.os === 'macos-26')).toBe(true);
  });

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
