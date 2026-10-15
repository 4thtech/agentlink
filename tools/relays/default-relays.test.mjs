// M1-18 (D-75): the default relay list has a single source. No source file outside
// packages/transport-nostr/src/default-relays.ts names a default relay; surfaces import DEFAULT_RELAYS.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const own = join(root, 'packages', 'transport-nostr', 'src', 'default-relays.ts');
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage', 'testing']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('default relay set: single source', () => {
  const src = readFileSync(own, 'utf8');
  const hosts = [...src.matchAll(/'wss:\/\/([^']+)'/g)].map((m) => m[1]);

  it('the source file lists the D-75 relays', () => {
    expect(hosts).toEqual(['nos.lol', 'relay.primal.net', 'relay.snort.social', 'nostr.mom']);
  });

  it('no other source file in packages, apps or tools names a default relay', () => {
    const hits = [];
    for (const top of ['packages', 'apps', 'tools']) {
      let files;
      try {
        files = walk(join(root, top), []);
      } catch {
        continue; // a sparse checkout may lack the directory
      }
      for (const file of files) {
        if (file === own) continue;
        const text = readFileSync(file, 'utf8');
        if (hosts.some((h) => text.includes(h))) hits.push(relative(root, file));
      }
    }
    expect(hits).toEqual([]);
  });
});
