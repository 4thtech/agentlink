// Docs lint for the SessionStart hook (M1-29 acceptance): a documented hook snippet never runs
// `npx` and only calls the installed program by absolute path.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGES = [
  '../../../docs-site/guide/get-started/claude-code.md',
  '../../../docs-site/guide/get-started/codex.md',
  '../../../docs-site/guide/get-started/gemini-cli.md',
  '../../../docs-site/technical/reference/harness-configuration.md',
  '../../../docs-site/technical/reference/cli.md',
];

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
}

describe('hook snippets in the docs', () => {
  const hookBlocks = PAGES.flatMap((page) =>
    fencedBlocks(read(page)).filter((b) => b.includes('SessionStart') || b.includes('--brief')),
  );

  it('documents at least the Claude Code snippet', () => {
    expect(hookBlocks.some((b) => b.includes('SessionStart'))).toBe(true);
  });

  it('never uses npx in a hook snippet', () => {
    for (const block of hookBlocks) expect(block).not.toMatch(/\bnpx\b/);
  });

  it('calls the program by absolute path, not by a bare name', () => {
    for (const block of hookBlocks.filter((b) => b.includes('"command"'))) {
      expect(block).toContain('<absolute path to node>');
      expect(block).toContain('<absolute path to the installed agentlink.js>');
    }
  });
});
