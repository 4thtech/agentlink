// DOCS-COMPACT-A: tests for tools/docs/build-knowledge.mjs (the Lumina knowledge bundle).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_TOKENS,
  buildBundle,
  cleanBody,
  estimateTokens,
  parseMarker,
} from './build-knowledge.mjs';

const STATUS = `updated: "2026-11-18"
version: "v0.5.11"
versionLabel: "M1b (pre-alpha, test networks)"
milestone: "M1b"
phase: "pre-alpha"
notYet: "mainnet"
inProgress: "0.5.12"
next: "0.6.0"
deploy:
  testnet:
    note: "Base Sepolia live."
  mainnet:
    note: "None."
  services:
    note: "Relays."
areas:
  - id: m0
    title: "M0"
    intro: "x"
    components:
      - name: "C"
        state: done
        summary: "s"
roadmap:
  - id: M1b
    name: "Files"
    outcome: "files"
    version: "0.5"
    duration: "x"
    state: in-progress
`;

function tree(pages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w('docs/status.yaml', STATUS);
  w('docs/foundation/04-security-and-crypto.md', '# 04\n');
  w(
    'docs-site/guide/SUMMARY.md',
    '# T\n\n* [What](README.md)\n* [How](how.md)\n\n## Help\n\n* [FAQ](help/faq.md)\n',
  );
  w(
    'docs-site/technical/SUMMARY.md',
    '# T\n\n* [Overview](README.md)\n\n## Concepts\n\n* [Arch](concepts/architecture.md)\n\n## Reference\n\n* [Networks](reference/networks-and-contracts.md)\n',
  );
  const defaults = {
    'docs-site/guide/README.md':
      '# What is AgentLink?\n\n<!-- ai-knowledge: full\nsummary: What AgentLink is. -->\n\n**AgentLink lets AIs talk.**\n',
    'docs-site/guide/how.md':
      '# How\n\n<!-- ai-knowledge: full\nsummary: How it works,\n  for newcomers. -->\n\nAlso on 4thTech Docs: [x](https://wiki.4thtech.io/x).\n\n*Applies to AgentLink 0.5.8.*\n\n## Steps\n\nSee the [FAQ](help/faq.md#q) and the [spec](../../docs/foundation/04-security-and-crypto.md).\n\n<figure><img src="../assets/a.webp" alt="A"><figcaption><p>Caption</p></figcaption></figure>\n\n![shot](../assets/b.webp)\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\n```sh\n# not a heading\n```\n',
    'docs-site/guide/help/faq.md':
      '# FAQ\n\n<!-- ai-knowledge: summary\nsummary: Short answers. -->\n\nLong body that is left out.\n',
    'docs-site/technical/README.md': '# Overview\n\n<!-- ai-knowledge: skip -->\n\nBody\n',
    'docs-site/technical/reference/networks-and-contracts.md': '# Networks\n<!-- ai-knowledge: skip -->\n',
    'docs-site/technical/concepts/architecture.md':
      '# Architecture\n\n<!-- ai-knowledge: summary\nsummary: Components. -->\n',
  };
  for (const [rel, text] of Object.entries({ ...defaults, ...pages })) if (text !== null) w(rel, text);
  return root;
}

describe('markers', () => {
  it('reads the three modes and the summary', () => {
    expect(parseMarker('# T\n\n<!-- ai-knowledge: full\nsummary: A b. -->\n')).toEqual({
      mode: 'full',
      summary: 'A b.',
    });
    expect(parseMarker('# T\n<!-- ai-knowledge: skip -->\n')).toEqual({ mode: 'skip', summary: '' });
    expect(parseMarker('# T\n\nNo marker\n')).toBe(null);
  });

  it('rejects a bad mode, a missing summary and a marker below the body', () => {
    expect(parseMarker('# T\n<!-- ai-knowledge: most\nsummary: x -->').error).toMatch(/not one of/);
    expect(parseMarker('# T\n<!-- ai-knowledge: full -->').error).toMatch(/needs a summary/);
    expect(parseMarker('# T\n\nText\n\n<!-- ai-knowledge: skip -->').error).toMatch(/under the H1/);
    expect(parseMarker('# T\n<!-- ai-knowledge: full\nnote: x -->').error).toMatch(/only a summary/);
  });
});

describe('body cleanup', () => {
  it('demotes headings and strips noise, but not inside code', () => {
    const out = cleanBody(
      '# Title\n\n<!-- c -->\n\n## A\n\n![i](x.png)\n\n```sh\n# keep\n<!-- keep -->\n```\n',
      (h) => h,
    );
    expect(out).toBe('### A\n\n```sh\n# keep\n<!-- keep -->\n```');
  });
});

describe('bundle', () => {
  it('builds in SUMMARY order with URLs, summaries and full bodies', () => {
    const r = buildBundle({ root: tree({}), tag: 'v0.5.11' });
    expect(r.problems).toEqual([]);
    const t = r.text;
    expect(t.startsWith('# AgentLink knowledge base\n')).toBe(true);
    expect(t).toContain('Generated from 4thtech/agentlink v0.5.11');
    expect(t).toContain('What AgentLink is.');
    expect(t).toContain('version v0.5.11');
    const order = ['## What is AgentLink?', '## How', '## FAQ', '## Architecture'].map((h) =>
      t.indexOf(h),
    );
    expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]))).toBe(true);
    expect(t).not.toContain('## Overview');
    expect(t).toContain('Page: https://wiki.4thtech.io/products/agentlink/how');
    expect(t).toContain('How it works, for newcomers.');
    expect(t).toContain('### Steps');
    expect(t).toContain('[FAQ](https://wiki.4thtech.io/products/agentlink/faq#q)');
    expect(t).toContain(
      '[spec](https://github.com/4thtech/agentlink/blob/v0.5.11/docs/foundation/04-security-and-crypto.md)',
    );
    expect(t).toContain('```sh\n# not a heading\n```');
    for (const gone of ['Caption', 'b.webp', 'flowchart', 'Also on 4thTech', 'Applies to AgentLink 0.5.8', 'ai-knowledge'])
      expect(t, gone).not.toContain(gone);
    expect(t).not.toContain('Long body that is left out');
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(buildBundle({ root: tree({}), tag: 'v0.5.11' }).text).toBe(t);
    expect(r.pages.map((p) => p.mode)).toEqual(['full', 'full', 'summary', 'skip', 'summary', 'skip']);
  });

  it('fails on a page without a marker unless an estimate is asked for', () => {
    const root = tree({ 'docs-site/guide/how.md': '# How\n\nBody\n' });
    expect(buildBundle({ root }).problems[0]).toMatch(/how\.md: no ai-knowledge marker/);
    const est = buildBundle({ root, assume: 'full' });
    expect(est.problems).toEqual([]);
    expect(est.text).toContain('Body');
  });

  it('fails above the hard cap and warns above the target and per page', () => {
    const big = 'word '.repeat(MAX_TOKENS * 4 / 5 + 100);
    const r = buildBundle({
      root: tree({ 'docs-site/guide/how.md': `# How\n<!-- ai-knowledge: full\nsummary: x -->\n\n${big}\n` }),
    });
    expect(r.problems.some((p) => /above the hard max 22000/.test(p))).toBe(true);
    expect(r.warnings.some((w) => /how\.md: \d+ tokens/.test(w))).toBe(true);
    const mid = 'word '.repeat(19_500 * 4 / 5);
    const m = buildBundle({
      root: tree({ 'docs-site/guide/how.md': `# How\n<!-- ai-knowledge: full\nsummary: x -->\n\n${mid}\n` }),
    });
    expect(m.problems).toEqual([]);
    expect(m.warnings.some((w) => /above the target 19000/.test(w))).toBe(true);
  });

  it('estimates tokens as bytes / 4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('builds from a compact-layout tree too', () => {
    const root = tree({});
    fs.renameSync(path.join(root, 'docs-site/guide'), path.join(root, 'docs/guide'));
    fs.renameSync(path.join(root, 'docs-site/technical'), path.join(root, 'docs/technical'));
    const r = buildBundle({ root, tag: 'v0.6.0' });
    expect(r.problems).toEqual([]);
    expect(r.text).toContain('Page: https://wiki.4thtech.io/products/agentlink/how');
  });
});
