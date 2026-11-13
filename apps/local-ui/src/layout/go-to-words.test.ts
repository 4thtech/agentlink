// UX-LEFT-1 (R1-UI-23): Go to finds a page by the words people type, not only by its title.
import { describe, expect, it } from 'vitest';
import { goToEntries } from '../nav.js';
import { matches } from './go-to.js';

const found = (q: string): string[] =>
  goToEntries(false)
    .filter((e) => matches(e, q))
    .map((e) => e.path ?? e.label);

describe('Go to words', () => {
  it('finds recovery, theme, dark, help, version and people', () => {
    expect(found('recovery')).toContain('/settings/backup');
    expect(found('theme')).toContain('/settings/appearance');
    expect(found('dark')).toContain('/settings/appearance');
    expect(found('help')).toContain('/settings/advanced');
    expect(found('version')).toContain('/settings/updates');
    expect(found('person').length).toBeGreaterThan(0);
  });
});
