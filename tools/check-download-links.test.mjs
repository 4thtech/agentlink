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

  it('rejects version placeholders and names without a v', () => {
    expect(checkText('a.md', 'AgentLink-{version}-mac-arm64.dmg')).toHaveLength(1);
    expect(checkText('a.md', 'AgentLink-$VERSION-mac-x64.dmg')).toHaveLength(1);
    expect(checkText('a.md', '4thtech/agentlink/releases/download/0.5.2/x.dmg')).toHaveLength(1);
    expect(checkText('a.md', '4thtech/agentlink/releases/download/{tag}/x.dmg')).toHaveLength(1);
  });

  it('ignores another project, and allows versioned names in the process docs', () => {
    expect(
      checkText('a.md', 'https://github.com/electron/electron/releases/download/v1.0.0/x'),
    ).toEqual([]);
    expect(checkText('docs/process/versioning.md', 'AgentLink-<version>-mac-arm64.dmg')).toEqual(
      [],
    );
    expect(
      checkText('docs/runbooks/x.md', '4thtech/agentlink/releases/download/v1/x.dmg'),
    ).toHaveLength(1);
  });

  it('covers docs/ but not docs/foundation, and more file types', () => {
    const files = collectFiles(root).map(([f]) => f);
    expect(files.some((f) => f.startsWith('docs/runbooks/'))).toBe(true);
    expect(files.some((f) => f.startsWith('docs/foundation/'))).toBe(false);
    expect(files.some((f) => f.endsWith('.json') || f.endsWith('.mjs') || f.endsWith('.js'))).toBe(
      true,
    );
  });

  it('passes on the real files', () => {
    const problems = collectFiles(root).flatMap(([file, text]) => checkText(file, text));
    expect(problems).toEqual([]);
  });
});
