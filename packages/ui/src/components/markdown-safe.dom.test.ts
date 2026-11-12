// @vitest-environment jsdom
// REL051-A34 (D-149; 08 §1; I-5): the in-repo Markdown and code renderer for a received text file.
// Another party wrote every byte, so the renderer builds React elements from a small subset
// (headings, paragraphs, emphasis, inline code, fenced code, lists, quotes, tables, rules) and
// nothing else:
//
// - no raw HTML (shown as text), no `dangerouslySetInnerHTML` or `innerHTML`;
// - no anchor, no `href` or `src`: a link shows its text and an inert chip with its domain that only
//   copies the address; a `javascript:`, `data:` or other non-web address is not even copyable;
// - no image is ever loaded: an image shows as an inert chip with its alt text and domain;
// - hidden and direction characters are removed;
// - nesting is capped and pathological input (very long lines, runs of delimiters) renders quickly.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeCode, SafeMarkdown } from './markdown-safe.js';
import rendererText from './markdown-safe.tsx?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const md = (text: string): void => {
  act(() => root.render(h(SafeMarkdown, { text })));
};

const FORBIDDEN_TAGS = [
  'a',
  'img',
  'iframe',
  'script',
  'style',
  'object',
  'embed',
  'form',
  'input',
  'video',
  'audio',
  'link',
  'meta',
  'base',
  'frame',
  'math',
];

/** No forbidden element, no event handler or URL attribute anywhere in the output. */
function assertInert(): void {
  for (const tag of FORBIDDEN_TAGS) expect(host.querySelectorAll(tag).length, tag).toBe(0);
  for (const el of host.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `${el.tagName} ${attr}`).toBe(false);
      expect(
        ['href', 'src', 'srcset', 'action', 'formaction', 'style', 'xlink:href'],
        attr,
      ).not.toContain(attr);
    }
  }
}

describe('SafeMarkdown: what it renders (REL051-A34)', () => {
  it('renders a build plan: headings, lists, emphasis, inline code, a table, a quote and a code block', () => {
    md(
      [
        '# Build plan',
        '',
        'We use **TypeScript** and *Vite* with `pnpm`.',
        '',
        '## Steps',
        '',
        '1. Scaffold',
        '2. Wire the API',
        '   - auth',
        '   - storage',
        '',
        '> Keep it small.',
        '',
        '| Part | Owner |',
        '| --- | :-: |',
        '| API | Ana |',
        '',
        '```ts',
        'const x: number = 1;',
        '```',
        '',
        '---',
      ].join('\n'),
    );
    // Document headings sit under the reader's own title (h2): level 1 renders as h3.
    expect(host.querySelector('h3')?.textContent).toBe('Build plan');
    expect(host.querySelector('h4')?.textContent).toBe('Steps');
    expect(host.querySelector('strong')?.textContent).toBe('TypeScript');
    expect(host.querySelector('em')?.textContent).toBe('Vite');
    expect(host.querySelector('p code')?.textContent).toBe('pnpm');
    expect(host.querySelectorAll('ol > li')).toHaveLength(2);
    expect(host.querySelectorAll('ol ul > li')).toHaveLength(2);
    expect(host.querySelector('blockquote')?.textContent).toContain('Keep it small.');
    expect([...host.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Part', 'Owner']);
    expect(host.querySelector('td')?.textContent).toBe('API');
    expect(host.querySelector('pre code')?.textContent).toBe('const x: number = 1;');
    expect(host.textContent).toContain('ts');
    expect(host.querySelector('hr')).not.toBeNull();
    assertInert();
  });

  it('copies a code block with its Copy button', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    md('```\nrm -rf build\n```');
    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Copy');
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('rm -rf build');
  });
});

describe('SafeMarkdown: hostile input stays inert (REL051-A34, I-5)', () => {
  it('raw HTML is text, never markup', () => {
    md(
      [
        '<script>alert(1)</script>',
        '<iframe src="https://evil.example/"></iframe>',
        '<img src=x onerror=alert(1)>',
        '<a href="javascript:alert(1)">x</a>',
        '<style>body{display:none}</style>',
        '<svg onload=alert(1)><foreignObject></foreignObject></svg>',
        '<form action="https://evil.example"><input name=p></form>',
        '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      ].join('\n\n'),
    );
    assertInert();
    expect(host.querySelectorAll('svg foreignObject')).toHaveLength(0);
    expect(host.textContent).toContain('<script>alert(1)</script>');
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('links never navigate: text plus an inert domain chip; unsafe schemes are not copyable', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    md(
      [
        '[the docs](https://docs.example.com/guide?x=1)',
        '[click me](javascript:alert(document.cookie))',
        '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '[vb](vbscript:msgbox(1))',
        '[file](file:///etc/passwd)',
        '<https://auto.example.org/path>',
        'bare https://bare.example.net/x and more',
      ].join('\n\n'),
    );
    assertInert();
    expect(host.textContent).toContain('the docs');
    expect(host.textContent).toContain('docs.example.com');
    expect(host.textContent).toContain('auto.example.org');
    expect(host.textContent).toContain('bare.example.net');
    expect(host.textContent).toContain('click me');
    expect(host.innerHTML).not.toMatch(/javascript:/i);
    expect(host.innerHTML).not.toMatch(/data:text/i);
    expect(host.innerHTML).not.toMatch(/vbscript:/i);
    // Copying is the only action: the web address goes to the clipboard on an explicit click.
    const copy = host.querySelector('button[data-link="web"]') as HTMLButtonElement;
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('https://docs.example.com/guide?x=1');
    // Non-web addresses get no copy button at all.
    expect(host.querySelectorAll('button[data-link="web"]')).toHaveLength(3);
  });

  it('images are never loaded: an inert chip with the alt text and domain', () => {
    md(
      '![architecture diagram](https://evil.example/track.png)\n\n![x](data:image/png;base64,AAAA)',
    );
    assertInert();
    expect(host.textContent).toContain('architecture diagram');
    expect(host.textContent).toContain('evil.example');
    expect(host.innerHTML).not.toContain('track.png');
  });

  it('removes hidden and direction characters', () => {
    md('# safe\u202Etxt.exe\n\nzero\u200Bwidth \u2066iso\u2069');
    expect(host.textContent).not.toMatch(/[\u200B\u202E\u2066\u2069]/);
    expect(host.textContent).toContain('safetxt.exe');
  });

  it('caps nesting of quotes and lists', () => {
    md(`${'>'.repeat(5_000)} deep`);
    expect(host.querySelectorAll('blockquote').length).toBeLessThanOrEqual(8);
    expect(host.textContent).toContain('deep');
    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) lines.push(`${'  '.repeat(i)}- level ${String(i)}`);
    md(lines.join('\n'));
    expect(host.querySelectorAll('ul').length).toBeLessThanOrEqual(8);
    expect(host.textContent).toContain('level 299');
  });

  it('renders pathological input quickly', () => {
    const cases = [
      'a'.repeat(250_000),
      '`'.repeat(100_000),
      '*a'.repeat(60_000),
      '_'.repeat(100_000),
      '['.repeat(80_000),
      '[a]('.repeat(40_000),
      '![a]('.repeat(40_000),
      '<'.repeat(100_000),
      '|a'.repeat(50_000) + '\n|' + '-|'.repeat(50_000),
      '#'.repeat(100_000),
      '- '.repeat(100_000),
      Array.from({ length: 10_000 }, (_, i) => `line ${String(i)} with **bold** and \`code\``).join(
        '\n',
      ),
    ];
    for (const text of cases) {
      const start = performance.now();
      md(text);
      expect(performance.now() - start, text.slice(0, 20)).toBeLessThan(3_000);
      assertInert();
    }
  });

  it('never uses innerHTML in its source', () => {
    expect(rendererText).not.toMatch(
      /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/,
    );
    expect(rendererText).not.toMatch(/<a\b|<img\b|createElement\(['"](a|img)['"]/);
  });
});

describe('SafeCode: code, JSON and patches as text with line numbers (REL051-A34)', () => {
  it('shows each line as text, numbered, with no markup', () => {
    act(() =>
      root.render(
        h(SafeCode, { text: 'const a = 1;\n<script>x</script>\nreturn a;\n', kind: 'code' }),
      ),
    );
    const lines = host.querySelectorAll('[data-line]');
    expect(lines).toHaveLength(3);
    expect([...lines].map((l) => l.getAttribute('data-line'))).toEqual(['1', '2', '3']);
    expect(host.textContent).toContain('<script>x</script>');
    assertInert();
  });

  it('marks added and removed lines of a patch', () => {
    act(() => root.render(h(SafeCode, { text: '@@ -1 +1 @@\n-old\n+new\n ctx', kind: 'patch' })));
    const kinds = [...host.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-diff'));
    expect(kinds).toEqual(['hunk', 'del', 'add', null]);
  });
});
