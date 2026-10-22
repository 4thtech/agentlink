// M1-11s-a: the production build meets the page CSP (08 §4: `script-src 'self'; style-src 'self'`)
// and caches for good: no inline script or style, no data: URIs, content-hashed asset names. The
// build runs in memory (`write: false`), so the test leaves no files behind.
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

interface Out {
  readonly fileName: string;
  readonly type: 'asset' | 'chunk';
  readonly text: string;
}
let outputs: Out[] = [];

beforeAll(async () => {
  const root = decodeURIComponent(new URL('../', import.meta.url).pathname);
  const result = await build({ root, logLevel: 'silent', build: { write: false } });
  const list = Array.isArray(result) ? result : [result];
  outputs = list.flatMap((r) =>
    'output' in r
      ? r.output.map((o) => ({
          fileName: o.fileName,
          type: o.type,
          text:
            o.type === 'chunk'
              ? o.code
              : typeof o.source === 'string'
                ? o.source
                : new TextDecoder().decode(o.source),
        }))
      : [],
  );
}, 120_000);

describe('production build', () => {
  it('has an index.html with only external scripts and no inline style', () => {
    const html = outputs.find((o) => o.fileName === 'index.html')?.text ?? '';
    expect(html).toContain('<div id="root">');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s[0]).toMatch(/\bsrc="\/assets\//);
      expect(s[1]).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('links its styles as a file', () => {
    const html = outputs.find((o) => o.fileName === 'index.html')?.text ?? '';
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/[^"]+\.css"/);
  });

  it('hashes every asset name and keeps them under assets/', () => {
    const files = outputs.filter((o) => o.fileName !== 'index.html');
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      expect(f.fileName).toMatch(/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
    }
  });

  it('keeps fonts as files, never data: URIs', () => {
    expect(outputs.some((o) => /\.woff2$/.test(o.fileName))).toBe(true);
    for (const o of outputs.filter((x) => /\.(css|js)$/.test(x.fileName))) {
      expect(o.text).not.toMatch(/url\(\s*["']?data:/i);
    }
  });
});
