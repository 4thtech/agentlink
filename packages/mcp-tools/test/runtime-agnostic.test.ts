// M2-3t (G-15, 06 §1, D-73 (1)): the tool handlers live in their own package so a Worker can import
// them. The ESLint fence stays in eslint.config.mjs; this test checks the source on top of it (it
// moved here unchanged from apps/cli/src/mcp/server.test.ts), and that the package declares no Node
// or MCP SDK dependency. A pure move: the registry export is pinned by src/registry.test.ts against
// src/__snapshots__/registry.test.ts.snap, which moved byte-identical.
//
// The sources are read through Vite's `import.meta.glob` (raw text, at transform time), so this
// test imports no Node built-in itself: the package forbids them, tests included.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/index.js';

type Glob = (pattern: string, options: object) => Record<string, string>;
const sources = (import.meta as unknown as { glob: Glob }).glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const manifestText = Object.values(
  (import.meta as unknown as { glob: Glob }).glob('../package.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0]!;
const files = Object.keys(sources).map((f) => f.slice('../src/'.length));

describe('the package declares no Node or MCP SDK dependency (06 §1)', () => {
  it('depends on no @4thtech-io/node, MCP SDK or Node-only package', () => {
    const fields = JSON.parse(manifestText) as Record<string, unknown>;
    const names = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].flatMap((field) => Object.keys((fields[field] ?? {}) as Record<string, string>));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/^@4thtech-io\/node$|^@modelcontextprotocol\/|^ws$|sqlite|keyring/);
    }
  });

  it('exports the tool registry (its surface is pinned by src/registry.test.ts and its snapshot)', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
  });
});

describe('the tool sources stay runtime-agnostic (06 §1; the ESLint fence, checked here on the source too)', () => {
  it('found the module', () => {
    expect(files).toContain('registry.ts');
  });

  for (const file of files) {
    it(file, () => {
      const text = sources[`../src/${file}`]!;
      const depth = file.split('/').length - 1;
      const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        expect(spec).not.toMatch(/^node:|^@4thtech-io\/node|^@modelcontextprotocol\//);
        if (spec.startsWith('.'))
          expect(spec.split('/').filter((p) => p === '..').length).toBeLessThanOrEqual(depth);
      }
      expect(text).not.toMatch(/\bimport\(|\brequire\(|\bprocess\.|\bBuffer\./);
    });
  }
});
