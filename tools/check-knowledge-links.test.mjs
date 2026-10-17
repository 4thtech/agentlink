import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER,
  checkLinks,
  countPlaceholders,
  extractLinks,
} from './check-knowledge-links.mjs';

const present = new Set([
  'README.md',
  'knowledge/agentlink-overview.md',
  'docs-site/guide/README.md',
]);
const exists = (path) => present.has(path);
const base = 'https://github.com/4thtech/agentlink/blob/main/';

describe('extractLinks', () => {
  it('finds inline link targets and skips fenced code', () => {
    const text = '[a](x.md) and [b](https://example.com)\n```\n[c](hidden.md)\n```\n';
    expect(extractLinks(text)).toEqual(['x.md', 'https://example.com']);
  });
});

describe('checkLinks', () => {
  it('accepts relative links that resolve from the file directory', () => {
    expect(
      checkLinks('knowledge/README.md', '[o](agentlink-overview.md) [r](../README.md)', exists),
    ).toEqual([]);
  });

  it('rejects a relative link that does not resolve', () => {
    expect(checkLinks('knowledge/README.md', '[x](missing.md)', exists)).toHaveLength(1);
    expect(checkLinks('knowledge/README.md', '[x](../../outside.md)', exists)).toHaveLength(1);
  });

  it('accepts absolute links into this repository that exist, with or without a fragment', () => {
    const text = `[a](${base}README.md) [b](${base}docs-site/guide/README.md#top)`;
    expect(checkLinks('llms.txt', text, exists)).toEqual([]);
  });

  it('rejects absolute links into this repository that point nowhere', () => {
    const problems = checkLinks('llms.txt', `[a](${base}docs-site/nope.md)`, exists);
    expect(problems).toEqual([`llms.txt: link target does not exist: ${base}docs-site/nope.md`]);
  });

  it('does not check other sites, mailto links or anchors', () => {
    const text = '[a](https://wiki.4thtech.io) [b](mailto:x@y.z) [c](#section)';
    expect(checkLinks('llms.txt', text, exists)).toEqual([]);
  });

  it('accepts the repository root', () => {
    expect(checkLinks('llms.txt', '[r](https://github.com/4thtech/agentlink)', exists)).toEqual([]);
  });
});

describe('countPlaceholders', () => {
  it('counts the wiki placeholders', () => {
    expect(countPlaceholders(`a ${PLACEHOLDER} b ${PLACEHOLDER}`)).toBe(2);
    expect(countPlaceholders('none')).toBe(0);
  });
});

describe('the committed knowledge base', () => {
  it('has no broken links', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const real = (path) => existsSync(join(root, path));
    for (const file of ['llms.txt', 'knowledge/README.md', 'knowledge/agentlink-userguide.md']) {
      expect(checkLinks(file, readFileSync(join(root, file), 'utf8'), real)).toEqual([]);
    }
  });
});
