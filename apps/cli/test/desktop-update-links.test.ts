// WIN-UPDATE (owner, 21 Nov 2026): the core accepts every link the desktop shell builds for an
// update. The shell's builders (apps/desktop/src/shared/app-update.ts) are not imported here
// (deps-check refuses a relative import across apps), so both packages' tests read one shared list:
// apps/desktop/test/unit/update-links-contract.test.ts checks the shell builds exactly these links,
// and this test checks the core's pipe parser takes each of them, bound to its version.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUpdateLinkFor } from '../src/desktop/protocol.js';

interface LinkFixture {
  readonly version: string;
  readonly links: Readonly<Record<string, string>>;
}
const FIXTURE = fileURLToPath(new URL('./fixtures/desktop-update-links.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as LinkFixture;

describe('WIN-UPDATE: the shell and the core agree on the update links', () => {
  it('the core accepts every link the shell builds (mac arm64, mac x64, win x64, release page)', () => {
    expect(Object.keys(fixture.links).sort()).toEqual([
      'macArm64',
      'macX64',
      'releasePage',
      'winX64',
    ]);
    for (const [name, url] of Object.entries(fixture.links)) {
      expect(isUpdateLinkFor(url, fixture.version), name).toBe(true);
    }
  });

  it('each link is bound to its version', () => {
    for (const [name, url] of Object.entries(fixture.links)) {
      expect(isUpdateLinkFor(url, '0.5.17'), name).toBe(false);
      expect(isUpdateLinkFor(url, '0.5.15'), name).toBe(false);
    }
  });
});
