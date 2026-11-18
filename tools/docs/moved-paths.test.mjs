// DOCS-PHASE-B: tools/docs/moved-paths.json maps the old documentation paths to the new ones, and
// the pointer stubs at old paths are exactly the set it lists (no stray old-path file, no missing stub).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './paths.mjs';

const moved = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools/docs/moved-paths.json'), 'utf8'));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(REPO_ROOT, p).split(path.sep).join('/'));
  }
  return out;
}

describe('moved-paths.json', () => {
  it('every stub is a file at its old path that points to an existing new path', () => {
    for (const [oldPath, newPath] of Object.entries(moved.stubs)) {
      expect(fs.existsSync(path.join(REPO_ROOT, newPath)), `${newPath} exists`).toBe(true);
      const text = fs.readFileSync(path.join(REPO_ROOT, oldPath), 'utf8');
      expect(text, oldPath).toMatch(/^# Moved\n/);
    }
  });

  it('the stub files are exactly the listed set', () => {
    const present = [...walk(path.join(REPO_ROOT, 'docs-site')), 'docs/foundation/README.md'].sort();
    expect(present).toEqual(Object.keys(moved.stubs).sort());
    expect(fs.existsSync(path.join(REPO_ROOT, 'docs/foundation'))).toBe(true);
    expect(walk(path.join(REPO_ROOT, 'docs/foundation'))).toEqual(['docs/foundation/README.md']);
  });

  it('the prefixes send an old path to a path that exists', () => {
    const resolve = (p) => {
      if (moved.files[p]) return moved.files[p];
      const rule = moved.prefixes.find((r) => p.startsWith(r.from));
      return rule ? rule.to + p.slice(rule.from.length) : p;
    };
    expect(resolve('docs/foundation/04-security-and-crypto.md')).toBe('specs/04-security-and-crypto.md');
    expect(resolve('docs-site/guide/pricing.md')).toBe('docs/guide/pricing.md');
    expect(resolve('docs/process/backlog.md')).toBe('project/process/backlog.md');
    expect(resolve('docs/README.md')).toBe('project/README.md');
    for (const p of ['docs/foundation/04-security-and-crypto.md', 'docs-site/guide/pricing.md']) {
      expect(fs.existsSync(path.join(REPO_ROOT, resolve(p)))).toBe(true);
    }
  });
});
