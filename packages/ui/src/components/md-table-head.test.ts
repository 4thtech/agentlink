// UX-LEFT-1 (R2-UI-12): reader table headers never break inside a word.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('markdown table headers', () => {
  it('keep a header on one line (the table scrolls sideways instead)', () => {
    const css = readFileSync(new URL('./components.css', import.meta.url), 'utf8');
    const rule = /\.al-md th \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('overflow-wrap: normal');
  });
});
