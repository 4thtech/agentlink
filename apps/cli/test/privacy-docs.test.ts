// M1-33b (D-109, 11 §5.6): the user-guide privacy page, proof page and credits page quote the same
// strings the tools and the CLI print, so a copy change cannot leave the docs behind.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../src/tools/strings/index.js';

const guide = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../docs-site/guide/${path}`, import.meta.url)), 'utf8');

describe('the user guide matches the 11 §5.6 strings', () => {
  const privacy = guide('privacy-and-security.md');
  it('privacy page: proof, top-up and export strings, and the receipt wording', () => {
    expect(privacy).toContain(en['common.privacy.proof']);
    expect(privacy).toContain(en['common.privacy.topUp']);
    expect(privacy).toContain(en['common.privacy.export']);
    expect(privacy).toContain('This is public: anyone can see that your agent opened');
  });
  it('proof page: the proof string', () => {
    expect(guide('everyday-use/agreements-and-proof.md')).toContain(en['common.privacy.proof']);
  });
  it('credits page: the top-up string', () => {
    expect(guide('everyday-use/credits.md')).toContain(en['common.privacy.topUp']);
  });
});
