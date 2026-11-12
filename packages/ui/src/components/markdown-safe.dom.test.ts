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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // 2000 levels written as indentation need about 4 MB, far over the 256 KB preview cap; the same
    // 2000 levels fit on one line as list markers, and as quote-and-list pairs.
    md(`${'- '.repeat(2_000)}deep list`);
    expect(host.querySelectorAll('ul').length).toBeLessThanOrEqual(8);
    expect(host.textContent).toContain('deep list');
    md(`${'> - '.repeat(2_000)}deep mix`);
    expect(host.querySelectorAll('ul, blockquote').length).toBeLessThanOrEqual(16);
    expect(host.textContent).toContain('deep mix');
    // Indented levels, as many as fit in a real file.
    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) lines.push(`${'  '.repeat(i)}- level ${String(i)}`);
    md(lines.join('\n'));
    expect(host.querySelectorAll('ul').length).toBeLessThanOrEqual(8);
    expect(host.textContent).toContain('level 299');
  });

  // IR-REL051-A34-1 (M1, M2, lows): every pathological 256 KB input renders in under 250 ms and
  // under 50 000 elements; past the document budget the rest is plain text with a short note.
  const K256 = 256 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.floor(K256 / unit.length));
  const table = `| a | b |\n| - | - |\n${'| 1 | 2 |\n'.repeat(2_000)}\n`;
  // Timed in steady state, not on the engine's first pass over the renderer: one warm-up render of
  // every construct, in its own root, before the timed cases.
  beforeAll(() => {
    const warm =
      '# h\n\n- a\n- b\n\n> q\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nx\n```\n\n*a* `b` [l](https://a.example) ![i](https://a.example/i.png) https://b.example\n\n';
    const el = document.createElement('div');
    const warmRoot = createRoot(el);
    act(() => warmRoot.render(h(SafeMarkdown, { text: warm.repeat(200) })));
    act(() => warmRoot.render(h(SafeCode, { text: '+a\n-b\n'.repeat(500), kind: 'patch' })));
    act(() => warmRoot.unmount());
  });
  const BUDGET_CASES: Record<string, string> = {
    'bare URL then punctuation': `http://x${'!'.repeat(K256)}a`,
    'bare URL longer than the cap': `https://x.example/${'a'.repeat(K256)}`,
    'repeated 2000-row tables': fill(table),
    'empty fences': fill('```\n```\n'),
    'open brackets then one close': `${'['.repeat(K256)}]`,
    'open brackets with a close and no paren': fill('[a]x '),
    'autolinks with spaces then one close': `${fill('<https://a ')}>`,
    'list items': fill('- a\n'),
    headings: fill('# h\n'),
    paragraphs: fill('x\n\n'),
    emphasis: fill('*a* '),
    'code spans': fill('`a` '),
    quotes: fill('> a\n\n'),
    links: fill('[a](https://a.example) '),
    images: fill('![a](https://a.example/i.png) '),
  };
  it.each(Object.keys(BUDGET_CASES))('%s: under 250 ms and 50 000 elements', (name) => {
    const text = BUDGET_CASES[name] as string;
    const start = performance.now();
    md(text);
    const took = performance.now() - start;
    expect(took).toBeLessThan(250);
    expect(host.querySelectorAll('*').length).toBeLessThan(50_000);
    assertInert();
  });

  it('says when the rest is shown as plain text, and keeps that text', () => {
    md(`${fill('- a\n')}\nLAST LINE`);
    expect(host.textContent).toContain('The rest of this file is shown as plain text.');
    expect(host.textContent).toContain('LAST LINE');
  });

  it('fills table rows only to their own cells', () => {
    md('| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 |');
    expect([...host.querySelectorAll('tbody tr')].map((r) => r.children.length)).toEqual([1, 3]);
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
    // The numbers are one column beside the code, hidden from a screen reader and from a copy.
    const gutter = host.querySelector('.al-code-gutter');
    expect(gutter?.textContent).toBe('1\n2\n3');
    expect(gutter?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.al-code-text')?.textContent).toBe(
      'const a = 1;\n<script>x</script>\nreturn a;',
    );
    assertInert();
  });

  it('renders 256 KB of empty lines in under 250 ms and 50 000 elements', () => {
    for (const kind of ['text', 'patch'] as const) {
      const start = performance.now();
      act(() => root.render(h(SafeCode, { text: '\n'.repeat(256 * 1024), kind })));
      expect(performance.now() - start, kind).toBeLessThan(250);
      expect(host.querySelectorAll('*').length, kind).toBeLessThan(50_000);
      expect(host.querySelector('.al-code-gutter')?.getAttribute('data-lines'), kind).toBe(
        String(256 * 1024),
      );
    }
    // A patch colours its first lines; the rest is plain text under the note.
    expect(host.textContent).toContain('The rest of this file is shown as plain text.');
  });

  it('marks added and removed lines of a patch', () => {
    act(() => root.render(h(SafeCode, { text: '@@ -1 +1 @@\n-old\n+new\n ctx', kind: 'patch' })));
    const kinds = [...host.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-diff'));
    expect(kinds).toEqual(['hunk', 'del', 'add', null]);
  });
});
