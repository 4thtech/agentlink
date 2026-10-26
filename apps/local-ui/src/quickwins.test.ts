// UX-031-QUICKWINS: the page fills the window, and the local app says "backup code" (11 §5.5).
import { describe, expect, it } from 'vitest';

const stringFiles = import.meta.glob<string>('./**/strings.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('UX-031-QUICKWINS: backup code wording', () => {
  it('no user-visible string in the local app says "owner code"', () => {
    const files = Object.entries(stringFiles);
    expect(files.length).toBeGreaterThan(3);
    for (const [file, source] of files) {
      // One shared hint may name the earlier "owner code" (0.2.0 owners; src/strings.ts).
      const without = source.replace(/Set up before 0\.3\.0\? Use the owner code from[^']*/, '');
      expect(without, file).not.toMatch(/owner code/i);
    }
  });
});
