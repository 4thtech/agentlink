// UX-031-QUICKWINS: the page fills the window, and the local app says "backup code" (11 §5.5).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = decodeURIComponent(new URL('./', import.meta.url).pathname);

function stringFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return stringFiles(full);
    return name === 'strings.ts' ? [full] : [];
  });
}

describe('UX-031-QUICKWINS: full window height', () => {
  it('gives html, body and #root the full viewport height in a file the page loads', () => {
    const css = readFileSync(join(here, 'app.css'), 'utf8');
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%/s);
    expect(css).toMatch(/min-height:\s*100dvh/);
    expect(readFileSync(join(here, 'main.tsx'), 'utf8')).toContain("import './app.css'");
  });
});

describe('UX-031-QUICKWINS: backup code wording', () => {
  it('no user-visible string in the local app says "owner code"', () => {
    const files = stringFiles(here);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/owner code/i);
    }
  });
});
