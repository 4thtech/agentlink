import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFiles } from './walk-files.mjs';

// CHORE-FLAKE-DEPLOY-PATHS-WALK: CI run 40898043615 threw ENOENT on a vitest temp file under
// apps/submitter/node_modules/.vite-temp that vanished while deploy-path-triggers walked the tree.
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'walk-files-'));
  dirs.push(d);
  return d;
}
const rel = (d, files) => files.map((f) => relative(d, f)).sort();

describe('walkFiles', () => {
  it('lists files and skips generated directories', () => {
    const d = fixture();
    mkdirSync(join(d, 'src'));
    mkdirSync(join(d, 'node_modules/.vite-temp'), { recursive: true });
    mkdirSync(join(d, 'dist'));
    writeFileSync(join(d, 'src/a.ts'), '');
    writeFileSync(join(d, 'package.json'), '');
    writeFileSync(join(d, 'node_modules/.vite-temp/vitest.config.ts.timestamp-1.mjs'), '');
    writeFileSync(join(d, 'dist/out.js'), '');
    expect(rel(d, walkFiles(d))).toEqual(['package.json', 'src/a.ts']);
  });

  it('skips a dangling symlink instead of throwing ENOENT', () => {
    const d = fixture();
    writeFileSync(join(d, 'a.ts'), '');
    symlinkSync(join(d, 'gone'), join(d, 'dangling'));
    expect(rel(d, walkFiles(d))).toEqual(['a.ts']);
  });

  it('returns nothing for a directory that vanished', () => {
    expect(walkFiles(join(fixture(), 'missing'))).toEqual([]);
  });
});
