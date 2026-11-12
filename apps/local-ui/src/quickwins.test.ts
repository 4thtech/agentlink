// UX-031-QUICKWINS, D-146: the local app says "master code", "Contact check" and "ID tag" (11 §5.5);
// the old user-facing words never come back in a string file.
import { describe, expect, it } from 'vitest';

const stringFiles = import.meta.glob<string>('./**/*strings.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('D-146: code names', () => {
  it('no user-visible string in the local app says "backup code", "owner code" or "safety code"', () => {
    const files = Object.entries(stringFiles);
    expect(files.length).toBeGreaterThan(3);
    for (const [file, source] of files) {
      expect(source, file).not.toMatch(/\b(?:backup|owner|safety) codes?\b/i);
      expect(source, file).not.toMatch(/\bowner fingerprints?\b/i);
    }
  });
});
