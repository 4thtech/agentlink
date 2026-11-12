// DOCS-UNIFY: tests for tools/docs/wiki-sync.mjs, the generator of the AgentLink part of 4thTech Docs.
// Ported from the wiki's scripts/test/sync-agentlink.test.mjs, plus the preflight on the real tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  TAG_RE,
  addHeader,
  checkState,
  compareTags,
  destFor,
  parseState,
  parseSummary,
  planNavigation,
  preflight,
  readRedirects,
  renderState,
  rewriteHref,
  rewriteLinks,
  sync,
  updateRedirects,
  updateSummary,
} from './wiki-sync.mjs';

const ctx = (srcRel, extra = {}) => ({
  tag: 'v9.9.9',
  srcRel,
  destRel: destFor(srcRel),
  map: new Map([
    ['docs-site/guide/README.md', 'agentlink/README.md'],
    ['docs-site/guide/pricing.md', 'agentlink/pricing.md'],
    ['docs-site/guide/get-started/README.md', 'agentlink/get-started/README.md'],
    ['docs-site/technical/reference/cli.md', 'agentlink/technical/reference/cli.md'],
  ]),
  kind: (p) =>
    ({
      'docs/process/docs-model.md': 'file',
      'docs/foundation': 'dir',
      'docs-site/MAINTAINING.md': 'file',
    })[p] ?? null,
  navMap: new Map([['products/agentlink', 'agentlink/README.md']]),
  ...extra,
});

describe('links and tags', () => {
  it('accepts release tags only', () => {
    expect(TAG_RE.test('v0.3.0')).toBe(true);
    for (const bad of ['main', '0.3.0', 'v0.3', 'v0.3.0/../x', 'v1.0.0 --upload-pack=x'])
      expect(TAG_RE.test(bad), bad).toBe(false);
    expect(compareTags('v0.4.15', 'v0.4.9')).toBeGreaterThan(0);
  });

  it('turns a guide link to a technical page into a wiki path', () => {
    const c = ctx('docs-site/guide/get-started/README.md');
    expect(
      rewriteHref(
        'https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/cli.md#flags',
        c,
      ),
    ).toBe('../technical/reference/cli.md#flags');
    expect(rewriteHref('../pricing.md', c)).toBe('../pricing.md');
    expect(rewriteHref('../../technical/reference/cli.md', c)).toBe(
      '../technical/reference/cli.md',
    );
  });

  it('pins links outside the synced folders to the tag', () => {
    const c = ctx('docs-site/guide/pricing.md');
    expect(
      rewriteHref(
        'https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md#x',
        c,
      ),
    ).toBe(
      'https://github.com/4thtech/agentlink/blob/v9.9.9/docs/foundation/04-security-and-crypto.md#x',
    );
    expect(rewriteHref('../../docs/process/docs-model.md', c)).toBe(
      'https://github.com/4thtech/agentlink/blob/v9.9.9/docs/process/docs-model.md',
    );
    expect(rewriteHref('https://example.com/a', c)).toBe('https://example.com/a');
    expect(rewriteHref('#top', c)).toBe('#top');
  });

  it('leaves links in code alone and makes wiki self-links relative', () => {
    const c = ctx('docs-site/guide/pricing.md');
    const md =
      'See [home](https://wiki.4thtech.io/products/agentlink) and `[a](https://github.com/4thtech/agentlink/blob/main/docs/x.md)`.\n\n```\n[b](../x.md)\n```\n';
    const out = rewriteLinks(md, c);
    expect(out).toContain('[home](README.md)');
    expect(out).toContain('`[a](https://github.com/4thtech/agentlink/blob/main/docs/x.md)`');
    expect(out).toContain('[b](../x.md)');
  });

  it('puts the synced header after front matter', () => {
    expect(addHeader('---\ndescription: x\n---\n# T\n', 'v1.0.0')).toBe(
      '---\ndescription: x\n---\n<!-- Synced from 4thtech/agentlink docs-site@v1.0.0. Edit there, not here. -->\n# T\n',
    );
  });

  it('merges redirects between markers and removes them again', () => {
    expect(readRedirects('root: ./\nredirects:\n  a/b: ./c.md\n')).toEqual([['a/b', './c.md']]);
    const base = 'root: ./\nredirects:\n  x: ./x.md\n';
    const withBlock = updateRedirects(base, [['agentlink/a', './agentlink/b.md']]);
    expect(withBlock).toContain('agentlink/a: ./agentlink/b.md');
    expect(updateRedirects(withBlock, [])).toBe(base);
  });

  it('reads back the state file it writes', () => {
    const text = renderState('v1.2.3', 'abc', new Map([['agentlink/a.md', 'f'.repeat(64)]]));
    expect(parseState(text)).toEqual({
      tag: 'v1.2.3',
      commit: 'abc',
      files: [{ path: 'agentlink/a.md', sha256: 'f'.repeat(64) }],
    });
  });
});

const GUIDE_SUMMARY =
  '# T\n\n* [What](README.md)\n* [How](how.md)\n\n## Get started\n\n* [Start](get-started/README.md)\n  * [Cursor](get-started/cursor.md)\n';
const TECH_SUMMARY =
  '# T\n\n* [Overview](README.md)\n\n## Concepts\n\n* [Arch](concepts/architecture.md)\n\n## Reference\n\n* [CLI](reference/cli.md)\n* [Networks](reference/networks-and-contracts.md)\n';
const WIKI_SUMMARY =
  '# Table of contents\n\n## Products\n\n* [AgentLink by 4thTech](agentlink/README.md)\n  * [Old](agentlink/get-started.md)\n* [Other](other.md)\n\n## Protocols\n\n* [OCC generation 2 (OCC v2)](protocols/occ-v2.md)\n\n## Developers\n\n* [Developers](developers/README.md)\n* [Next](next.md)\n\n## Deployments\n\n* [OCC v1 networks](occ-v1/reference/networks.md)\n\n## Resources\n';

describe('navigation', () => {
  it('rebuilds the SUMMARY blocks and re-running changes nothing', () => {
    const nav = planNavigation(parseSummary(GUIDE_SUMMARY), parseSummary(TECH_SUMMARY));
    const once = updateSummary(WIKI_SUMMARY, nav);
    expect(once).toContain('  * [How](agentlink/how.md)');
    expect(once).toContain('    * [Cursor](agentlink/get-started/cursor.md)');
    expect(once).not.toContain('agentlink/get-started.md');
    expect(once).toContain('  * [Arch](agentlink/technical/concepts/architecture.md)');
    expect(once).toContain(
      '* [Build with AgentLink (OCC v2)](agentlink/technical/README.md)\n  * [CLI](agentlink/technical/reference/cli.md)\n* [Next](next.md)',
    );
    expect(once).toContain('* [Other](other.md)');
    expect(updateSummary(once, nav)).toBe(once);
  });

  it('fails loudly on a new technical section', () => {
    expect(() =>
      planNavigation(
        parseSummary(GUIDE_SUMMARY),
        parseSummary(`${TECH_SUMMARY}\n## Extras\n\n* [X](x.md)\n`),
      ),
    ).toThrow(/Extras/);
  });
});

function fixture() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-src-'));
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-wiki-'));
  const w = (base, rel, text) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w(src, 'docs-site/guide/SUMMARY.md', GUIDE_SUMMARY);
  w(src, 'docs-site/guide/.gitbook.yaml', 'root: ./\n');
  w(
    src,
    'docs-site/guide/README.md',
    '# What\n\n[go](get-started/README.md) [spec](../../docs/x.md)\n',
  );
  w(src, 'docs-site/guide/how.md', '# How\n');
  w(src, 'docs-site/guide/get-started/README.md', '# Start\n');
  w(src, 'docs-site/guide/get-started/cursor.md', '# Cursor\n');
  w(src, 'docs-site/technical/SUMMARY.md', TECH_SUMMARY);
  w(src, 'docs-site/technical/README.md', '# Overview\n');
  w(src, 'docs-site/technical/concepts/architecture.md', '# Arch\n');
  w(src, 'docs-site/technical/reference/cli.md', '# CLI\n');
  w(src, 'docs-site/technical/reference/networks-and-contracts.md', '# Networks\n');
  w(src, 'docs/x.md', 'x\n');
  w(wiki, 'SUMMARY.md', WIKI_SUMMARY);
  w(wiki, '.gitbook.yaml', 'root: ./\nredirects:\n  a: ./a.md\n');
  w(wiki, 'agentlink/get-started.md', 'old\n');
  return { src, wiki };
}

describe('sync', () => {
  it('copies, rewrites, records hashes, and --check catches hand edits', () => {
    const { src, wiki } = fixture();
    const r = sync({ tag: 'v9.9.9', srcRoot: src, commit: 'abc', root: wiki });
    expect(r.pages).toBe(8);
    expect(r.removed).toEqual(['agentlink/get-started.md']);
    const readme = fs.readFileSync(path.join(wiki, 'agentlink/README.md'), 'utf8');
    expect(readme).toContain('Synced from 4thtech/agentlink docs-site@v9.9.9');
    expect(readme).toContain('[go](get-started/README.md)');
    expect(readme).toContain('https://github.com/4thtech/agentlink/blob/v9.9.9/docs/x.md');
    expect(fs.existsSync(path.join(wiki, 'agentlink/SUMMARY.md'))).toBe(false);
    expect(checkState(wiki)).toEqual([]);
    const again = sync({ tag: 'v9.9.9', srcRoot: src, commit: 'abc', root: wiki });
    expect([again.added, again.removed]).toEqual([[], []]);
    fs.appendFileSync(path.join(wiki, 'agentlink/how.md'), 'hand edit\n');
    fs.writeFileSync(path.join(wiki, 'agentlink/extra.md'), 'new\n');
    const problems = checkState(wiki);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('agentlink/how.md: edited by hand'))).toBe(true);
    expect(problems.some((p) => p.startsWith('agentlink/extra.md: not part of the sync'))).toBe(
      true,
    );
  });

  it('stops on a page missing from the source SUMMARY', () => {
    const { src, wiki } = fixture();
    fs.writeFileSync(path.join(src, 'docs-site/guide/orphan.md'), '# O\n');
    expect(() => sync({ tag: 'v9.9.9', srcRoot: src, commit: 'abc', root: wiki })).toThrow(
      /orphan/,
    );
  });

  it('copies shared screenshots and points guide images at them', () => {
    const { src, wiki } = fixture();
    fs.mkdirSync(path.join(src, 'docs-site/assets/screens'), { recursive: true });
    fs.writeFileSync(path.join(src, 'docs-site/assets/screens/home.webp'), 'RIFF');
    fs.appendFileSync(
      path.join(src, 'docs-site/guide/README.md'),
      '\n<figure><img src="../assets/screens/home.webp" alt="Home"></figure>\n',
    );
    sync({ tag: 'v9.9.9', srcRoot: src, commit: 'abc', root: wiki });
    expect(fs.existsSync(path.join(wiki, 'agentlink/.gitbook/assets/screens/home.webp'))).toBe(
      true,
    );
    const readme = fs.readFileSync(path.join(wiki, 'agentlink/README.md'), 'utf8');
    expect(readme).toContain('src=".gitbook/assets/screens/home.webp"');
  });
});

describe('preflight', () => {
  it('finds a link that would break in the wiki copy', () => {
    const { src } = fixture();
    fs.appendFileSync(path.join(src, 'docs-site/guide/how.md'), '\n[gone](missing.md)\n');
    const problems = preflight(src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/agentlink\/how\.md: "missing\.md" does not resolve/);
  });

  it('reports an unlisted page instead of throwing', () => {
    const { src } = fixture();
    fs.writeFileSync(path.join(src, 'docs-site/guide/orphan.md'), '# O\n');
    expect(preflight(src)[0]).toMatch(/not in its SUMMARY\.md/);
  });

  // The real tree: every docs-site change must still generate a clean 4thTech Docs copy.
  it('passes on this repository', () => {
    expect(preflight(REPO_ROOT)).toEqual([]);
  });
});
