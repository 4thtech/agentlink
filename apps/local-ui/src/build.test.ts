// M1-11s-a: the production build meets the page CSP (08 §4: `script-src 'self'; style-src 'self'`)
// and caches for good: no inline script or style, no data: URIs, content-hashed asset names. The
// build runs in memory (`write: false`), so the test leaves no files behind.
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

interface Out {
  readonly fileName: string;
  readonly type: 'asset' | 'chunk';
  readonly text: string;
  /** Chunks only: the module ids bundled in, and the chunks imported at load (not dynamic). */
  readonly modules: readonly string[];
  readonly imports: readonly string[];
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
          modules: o.type === 'chunk' ? Object.keys(o.modules) : [],
          imports: o.type === 'chunk' ? o.imports : [],
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
    // Case-insensitive and tolerant of an end tag with spaces or attributes (`</SCRIPT >`).
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s[0]).toMatch(/\bsrc="\/assets\//i);
      expect(s[1]).toBe('');
    }
    // No script opening tag escapes the pairs above, whatever its case.
    expect([...html.matchAll(/<script\b/gi)].length).toBe(scripts.length);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('links its styles as a file', () => {
    const html = outputs.find((o) => o.fileName === 'index.html')?.text ?? '';
    expect(html).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/[^"]+\.css"/);
  });

  it('UX-031-QUICKWINS: makes html, body and #root fill the window', () => {
    const css = outputs
      .filter((o) => o.fileName.endsWith('.css'))
      .map((o) => o.text)
      .join('\n');
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{\s*height:\s*100%/);
    expect(css).toMatch(/min-height:\s*100dvh/);
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

// UI-REFRESH-u: the Settings pages and the Under the hood panel load on first use.
describe('first load (UI-REFRESH-u)', () => {
  const LAZY_MODULES =
    /\/pages\/(home|activity|messages|contacts|files|proofs|rules|about|appearance|backup|advanced)\/index\.tsx$|\/components\/hood\.js$/;

  /** Every chunk the page loads at start: the scripts in index.html and what they import. */
  function initialChunks(): Out[] {
    const html = outputs.find((o) => o.fileName === 'index.html')?.text ?? '';
    const names = new Set<string>(
      [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] as string),
    );
    const seen = new Set<string>();
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...(outputs.find((o) => o.fileName === name)?.imports ?? []));
    }
    return outputs.filter((o) => seen.has(o.fileName));
  }

  it('carries no Settings page and not the Under the hood panel in the first load', () => {
    const initial = initialChunks();
    expect(initial.length).toBeGreaterThan(0);
    for (const chunk of initial) {
      expect(chunk.modules.filter((m) => LAZY_MODULES.test(m))).toEqual([]);
    }
  });

  it('ships each lazy part as its own chunk, loaded by a dynamic import', () => {
    const initial = new Set(initialChunks().map((c) => c.fileName));
    const lazy = outputs.filter(
      (o) => o.type === 'chunk' && o.modules.some((m) => LAZY_MODULES.test(m)),
    );
    // 11 pages plus the panel.
    expect(lazy.length).toBeGreaterThanOrEqual(12);
    for (const chunk of lazy) expect(initial.has(chunk.fileName)).toBe(false);
  });
});
