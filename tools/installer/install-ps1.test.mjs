// INSTALLER-1 (owner Decision 58): installer/install.ps1, the one-line installer for Windows.
// The behaviour checks are PowerShell (install-ps1.tests.ps1), run here with pwsh, which the CI
// Linux image has; the source checks below need no PowerShell. A real Windows run is not part of CI.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NODE_VERSION, SIGNED_SHASUMS, findTool, removeAll } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../installer/install.ps1');
const source = readFileSync(SCRIPT, 'utf8');
const pwsh = findTool('pwsh');
const temps = [];
afterAll(() => removeAll(temps));

/** pwsh is required on CI; a laptop without it skips only the checks that run PowerShell. */
function needPwsh() {
  if (pwsh) return true;
  expect(process.env.CI, 'pwsh is required on CI').toBeFalsy();
  return false;
}

describe('install.ps1 behaviour (pwsh)', () => {
  it('passes every check of install-ps1.tests.ps1', () => {
    if (!needPwsh()) return;
    const work = mkdtempSync(join(tmpdir(), 'agentlink-installer-ps1-'));
    temps.push(work);
    const r = spawnSync(
      pwsh,
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(here, 'install-ps1.tests.ps1'),
        '-Script',
        SCRIPT,
        '-Work',
        work,
      ],
      { encoding: 'utf8', timeout: 140_000 },
    );
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).toContain('all install.ps1 checks passed');
    expect(out.match(/^ok: /gm)?.length ?? 0, out).toBeGreaterThanOrEqual(18);
    // pwsh start-up plus zipping and unzipping the fixture several times: well over the 20 s default.
  }, 150_000);

  it('refuses to run on macOS or Linux, pointing to install.sh', () => {
    if (!needPwsh()) return;
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', SCRIPT, '-DryRun'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/This installer is for Windows.*install\.sh \| sh/);
  }, 90_000);
});

describe('install.ps1 source', () => {
  it('pins the hashes of nodejs.org signed SHASUMS256.txt for its Node.js version', () => {
    expect(source).toContain(`$NodeVersion = '${NODE_VERSION}'`);
    for (const platform of ['win-x64', 'win-arm64']) {
      const sha = SIGNED_SHASUMS[`node-v${NODE_VERSION}-${platform}.zip`];
      expect(source).toContain(`'${platform}' { return '${sha}' }`);
    }
  });

  it('pins the same Node.js version as install.sh', () => {
    const sh = readFileSync(join(here, '../../installer/install.sh'), 'utf8');
    expect(sh).toContain(`NODE_VERSION=${NODE_VERSION}\n`);
  });

  it('writes a .cmd launcher (no execution-policy prompt) and edits only the user PATH', () => {
    expect(source).toMatch(/'agentlink\.cmd'/);
    expect(source).toContain("'HKCU:\\Environment'");
    expect(source).not.toMatch(/HKLM:|'Machine'|RunAs|Set-ExecutionPolicy/);
  });

  it('keeps to Windows PowerShell 5.1 syntax', () => {
    const code = source.replace(/^\s*#.*$/gm, '');
    // No PowerShell 7-only operators: null-coalescing, ternary, pipeline chains, -Parallel.
    expect(code).not.toMatch(/\?\?|\s\?\s.*\s:\s|&&|\|\||-Parallel/);
  });

  it('downloads only over HTTPS from nodejs.org and uses plain words', () => {
    const urls = [...source.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/(nodejs\.org\/dist\/|agentlink\.4thtech\.io|github\.com\/4thtech\/agentlink)/,
      );
    }
    expect(source).not.toMatch(/wallet|\bgas\b|seed phrase|transaction/i);
    // irm in Windows PowerShell 5.1 may decode without a charset; ASCII reads the same either way.
    expect(source).not.toMatch(/[^\t\n -~]/);
  });
});
