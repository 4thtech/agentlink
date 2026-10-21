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
    expect(privacy).toContain(
      en['common.privacy.receiptPublic'].replace('{receipt}', 'opened (accepted, rejected)'),
    );
  });
  it('proof page: the proof string', () => {
    expect(guide('everyday-use/agreements-and-proof.md')).toContain(en['common.privacy.proof']);
  });
  it('credits page: the top-up string', () => {
    expect(guide('everyday-use/credits.md')).toContain(en['common.privacy.topUp']);
  });
});

// M1-33d (D-109): asking for a delivery receipt and confirming one are built, so the guide quotes
// the 11 §5.6 lines the tools print, and no longer calls them planned.
describe('the user guide covers delivery receipt requests (M1-33d)', () => {
  const privacy = guide('privacy-and-security.md');
  const proof = guide('everyday-use/agreements-and-proof.md');
  it('quotes the ask and the request lines (contact name shown as "Ana")', () => {
    for (const page of [privacy, proof]) {
      expect(page).toContain(en['common.privacy.receiptAsk'].replace('{contactName}', 'Ana'));
      expect(page).toContain(en['common.privacy.receiptRequest'].replace('{contactName}', 'Ana'));
    }
  });
  it('no longer says asking for a receipt is planned', () => {
    expect(privacy).not.toMatch(/Asking a contact for one, being told when someone asks you/);
    expect(proof).not.toMatch(/asking for one and turning them on for a contact are planned/);
  });
});
