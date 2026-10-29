// W4-VERIFY: the pure parts of `pnpm verify` (tools/verify/index.mjs): which base to diff against,
// the changed-file list, the steps to run and the PR summary. The package selection is the one CI uses
// (tools/ci/select-affected.mjs), so a green `pnpm verify` and a green `checks` job mean the same.
import { selectAffected, turboFilters } from '../ci/select-affected.mjs';

const E2E = '@4thtech-io/e2e';
const TASKS = ['build', 'typecheck', 'lint', 'check', 'test'];
const MAX_LINES = 30;

/** `origin/wave-4` while it exists and the branch sits on top of it, else `origin/main`. */
export function pickBase({ hasWave4, wave4Closer }) {
  return hasWave4 && wave4Closer ? 'origin/wave-4' : 'origin/main';
}

/** Diff output plus untracked files (one name per line each) as a sorted, unique list. */
export function parseChanged(diff, untracked) {
  const names = `${diff}\n${untracked}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(names)].sort();
}

/**
 * @param {{ files: string[], workspace: object[], journey?: boolean, wave3?: boolean,
 *   exists?: (file: string) => boolean }} input
 * @returns {{ scope: 'full' | 'filtered', packages: string[], steps: Array<{ id: string,
 *   label: string, cmd: 'turbo' | 'pnpm' | 'node', args: string[], env?: Record<string, string> }> }}
 */
export function buildPlan({
  files,
  workspace,
  journey = false,
  wave3 = false,
  exists = () => true,
}) {
  const sel = selectAffected({ files, workspace });
  const filters = sel.scope === 'filtered' ? turboFilters(sel.packages).split(' ') : [];
  const steps = [
    {
      id: 'turbo',
      label: `turbo ${TASKS.join(' ')}`,
      cmd: 'turbo',
      args: ['run', ...TASKS, ...filters],
    },
  ];
  // Prettier skips prose (`*.md`) and everything in .prettierignore; deleted files are gone.
  const format = files.filter((f) => !f.endsWith('.md') && exists(f));
  if (format.length > 0) {
    steps.push({
      id: 'prettier',
      label: `prettier --check (${format.length} file${format.length === 1 ? '' : 's'})`,
      cmd: 'pnpm',
      args: ['exec', 'prettier', '--check', '--ignore-unknown', ...format],
    });
  }
  steps.push({
    id: 'deps-check',
    label: 'deps-check',
    cmd: 'node',
    args: ['tools/deps-check/index.mjs'],
  });
  const e2eSelected = sel.scope === 'full' || sel.packages.includes(E2E);
  const tests = [journey && 'test/journey', wave3 && 'test/local-app-wave3.test.ts'].filter(
    Boolean,
  );
  if (e2eSelected && tests.length > 0) {
    steps.push({
      id: 'journey',
      label: 'journey e2e (CI=1)',
      cmd: 'pnpm',
      args: ['--filter', E2E, 'exec', 'vitest', 'run', ...tests],
      env: { CI: '1' },
    });
  }
  return {
    scope: sel.scope,
    packages: sel.scope === 'filtered' ? sel.packages : [],
    steps,
  };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * The block to paste into a PR: at most 30 lines.
 * @param {{ base: string, files: string[], scope: string, packages: string[],
 *   results: Array<{ id: string, label: string, ok: boolean, ms: number }>, skipped: string[] }} input
 */
export function summarize({ base, files, scope, packages, results, skipped }) {
  const ok = results.every((r) => r.ok) && skipped.length === 0;
  const total = results.reduce((n, r) => n + r.ms, 0);
  const lines = [
    `pnpm verify: ${ok ? 'PASS' : 'FAIL'} in ${formatDuration(total)}`,
    `base ${base}, ${files.length} file${files.length === 1 ? '' : 's'} changed`,
  ];
  if (scope === 'full') {
    lines.push('scope: full (global trigger or empty diff), no package filter');
  } else {
    const shown = packages.map((p) => p.replace('@4thtech-io/', ''));
    const head = shown.slice(0, 12).join(' ');
    lines.push(
      `scope: ${packages.length} package${packages.length === 1 ? '' : 's'}: ${head}${shown.length > 12 ? ` +${shown.length - 12} more` : ''}`,
    );
  }
  const width = Math.max(0, ...results.map((r) => r.label.length));
  for (const r of results) {
    lines.push(`${r.label.padEnd(width)}  ${r.ok ? 'ok' : 'FAIL'}  ${formatDuration(r.ms)}`);
  }
  if (skipped.length > 0)
    lines.push(`not run (stopped at the first failure): ${skipped.join(', ')}`);
  return lines.slice(0, MAX_LINES).join('\n');
}
