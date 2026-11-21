// WIN-UPDATE (owner, 21 Nov 2026): the shell builds exactly the update links in the list the core's
// test also reads (apps/cli/test/desktop-update-links.test.ts checks the core's pipe parser takes
// each one). A new or changed link here fails until the shared list, and so the core, follow.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isDownloadUrlFor,
  macDownloadUrl,
  releasePageUrl,
  winDownloadUrl,
} from '../../src/shared/app-update.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const fixture = JSON.parse(
  readFileSync(join(REPO, 'apps/cli/test/fixtures/desktop-update-links.json'), 'utf8'),
) as { readonly version: string; readonly links: Readonly<Record<string, string>> };

describe('WIN-UPDATE: the update links the core accepts', () => {
  it('are exactly the links the shell builds', () => {
    const v = fixture.version;
    expect(fixture.links).toEqual({
      macArm64: macDownloadUrl(v, 'arm64'),
      macX64: macDownloadUrl(v, 'x64'),
      winX64: winDownloadUrl(v),
      releasePage: releasePageUrl(v),
    });
    for (const url of Object.values(fixture.links)) expect(isDownloadUrlFor(url, v)).toBe(true);
  });
});
