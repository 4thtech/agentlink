// REPO-CLEAN-1 (P-2): the published package carries the notices of the third-party code and assets
// in the embedded local app (React, react-dom, scheduler, qrcode-generator, Geist, Lucide).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED, thirdPartyNotices } from '../scripts/third-party-notices.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('THIRD-PARTY-NOTICES.md', () => {
  it('lists every third-party runtime dependency of the local app', () => {
    const localUi = JSON.parse(
      readFileSync(join(repoRoot, 'apps/local-ui/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const thirdParty = Object.keys(localUi.dependencies).filter(
      (name) => !name.startsWith('@4thtech-io/'),
    );
    const listed = BUNDLED.map((entry) => entry.name);
    for (const name of thirdParty) expect(listed).toContain(name);
  });

  it('carries each package with its version and licence text, and the font and icon licences', () => {
    const text = thirdPartyNotices();
    for (const entry of BUNDLED) expect(text).toMatch(new RegExp(`## ${entry.name} \\d+\\.\\d+`));
    expect(text).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
    expect(text).toContain('Copyright (c) 2009 Kazuhiko Arase');
    expect(text).toContain('SIL Open Font License, Version 1.1');
    expect(text).toContain('ISC License');
    expect(text).not.toContain('fonts/OFL.txt');
  });
});
