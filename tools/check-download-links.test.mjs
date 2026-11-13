// REL-LINKS-3: the Mac download links never name a version. This test checks the rules and the real
// public docs (README, docs-site, knowledge, llms.txt, apps/invite/src).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkText, collectFiles, STABLE_BASE } from './check-download-links.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-download-links', () => {
  it('accepts the stable links', () => {
    const text = `[Mac](${STABLE_BASE}/AgentLink-mac-arm64.dmg) and AgentLink-mac-x64.dmg`;
    expect(checkText('README.md', text)).toEqual([]);
  });

  it('rejects a versioned download URL', () => {
    const text = '[Mac](https://github.com/4thtech/agentlink/releases/download/v0.5.2/x.dmg)';
    expect(checkText('README.md', text)).toHaveLength(1);
  });

  it('rejects a versioned .dmg name', () => {
    expect(checkText('a.md', 'file `AgentLink-0.5.2-mac-arm64.dmg`')).toHaveLength(1);
    expect(checkText('a.md', 'file AgentLink-<version>-mac-x64.dmg')).toHaveLength(1);
  });

  it('passes on the real files', () => {
    const problems = collectFiles(root).flatMap(([file, text]) => checkText(file, text));
    expect(problems).toEqual([]);
  });
});
