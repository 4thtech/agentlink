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
      expect(source, file).not.toMatch(/owner code/i);
    }
  });
});
