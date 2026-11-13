import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A workflow that sparse-checks-out a script must also list every relative file the script
// imports (transitively), or the job fails at run time with ERR_MODULE_NOT_FOUND (ci-green
// pick-up, 2026-11). This parses each workflow's `sparse-checkout: |` list and checks it.

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOWS = join(ROOT, '.github/workflows');

const sparseLists = (text) => {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)sparse-checkout:\s*\|\s*$/);
    if (!m) continue;
    const list = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || l.search(/\S/) <= m[1].length) break;
      list.push(l.trim());
    }
    out.push(list);
  }
  return out;
};

const relativeImports = (file) => {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const found = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)];
  return found.map((m) => normalize(join(dirname(file), m[1])));
};

const closure = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const dep of relativeImports(file)) if (existsSync(join(ROOT, dep))) closure(dep, seen);
  return seen;
};

describe('workflow sparse-checkout lists', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  for (const f of files) {
    for (const list of sparseLists(readFileSync(join(WORKFLOWS, f), 'utf8'))) {
      it(`${f}: every sparse-checked-out .mjs has its relative imports listed`, () => {
        const missing = [];
        for (const entry of list.filter((e) => e.endsWith('.mjs'))) {
          for (const dep of closure(entry)) if (!list.includes(dep)) missing.push(`${entry} -> ${dep}`);
        }
        expect(missing).toEqual([]);
      });
    }
  }
  it('finds at least one sparse-checkout list', () => {
    const n = files.reduce((a, f) => a + sparseLists(readFileSync(join(WORKFLOWS, f), 'utf8')).length, 0);
    expect(n).toBeGreaterThan(0);
  });
});
