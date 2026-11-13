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
import {
  MARKDOWN_PIECE_MAX,
  MARKDOWN_SLICE,
  MARKDOWN_TOTAL,
  SafeCode,
  SafeMarkdown,
} from './markdown-safe.js';
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

/** Elements drawn so far (a live collection: no copy of the tree per count). */
const drawn = (): number => host.getElementsByTagName('*').length;

// REL051-CIE: the DoS guarantees are checked by COUNTING the work (elements drawn per render or
// slice, and slices per document), which is deterministic on any machine. Wall-clock time is only a
// second, coarse guard: shared CI runners were 5-10x slower than a laptop and failed a 250 ms bound
// on healthy code, while a quadratic regression on 256 KB still takes far longer than this ceiling.
const WALL_CLOCK_CEILING_MS = 2_000;
/** Elements one top-level piece may draw beyond its cost (wrappers, a link or image chip's parts). */
const ELEMENTS_PER_COST = 2;
/** The most elements one slice may add: a full slice plus one maximal piece, with chip parts. */
const SLICE_ELEMENTS_MAX = (MARKDOWN_SLICE + MARKDOWN_PIECE_MAX) * ELEMENTS_PER_COST;
/**
 * The most slices one document may take. A slice stops only when the next piece would take it past
 * MARKDOWN_SLICE, so any two slices in a row draw more than MARKDOWN_SLICE: at most two slices per
 * MARKDOWN_SLICE of the drawn budget, plus the plain-text rest.
 */
const SLICES_MAX = 2 * Math.ceil(MARKDOWN_TOTAL / MARKDOWN_SLICE) + 2;
/** A drain test draws up to SLICES_MAX slices; give a loaded CI runner room for every one. */
const DRAIN_TIMEOUT_MS = SLICES_MAX * WALL_CLOCK_CEILING_MS;

/**
 * Lets the later slices draw (each in its own task) until the document is complete; answers how
 * long the slowest slice took, how many slices there were and the most elements one slice added.
 */
async function drain(): Promise<{ slowest: number; slices: number; mostAdded: number }> {
  let slowest = 0;
  let slices = 0;
  let mostAdded = 0;
  while (host.querySelector('.al-md[aria-busy="true"]') !== null && slices < 1_000) {
    const before = drawn();
    const start = performance.now();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    slowest = Math.max(slowest, performance.now() - start);
    mostAdded = Math.max(mostAdded, drawn() - before);
    slices += 1;
  }
  return { slowest, slices, mostAdded };
}

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

/** A realistic build plan of about 60 KB: sections with nested lists, tables and code. */
function realisticPlan(): { text: string; sections: number } {
  const parts: string[] = [
    '# Build plan: class project',
    '',
    "Written by **Ana**'s AI for the team.",
    '',
  ];
  let sections = 0;
  while (parts.join('\n').length < 60_000) {
    sections += 1;
    const n = String(sections);
    parts.push(
      `## Part ${n}: module ${n}`,
      '',
      `The *module ${n}* owns its data and talks to the API through \`client${n}.ts\`. See [the guide](https://docs.example.com/part-${n}).`,
      '',
      '### Steps',
      '',
      `1. Scaffold \`src/module${n}\``,
      '2. Add the routes',
      '   - list and detail',
      '   - create, with **validation**',
      '     - name is required',
      '     - email must look like an email',
      '3. Write the tests',
      '',
      '| Task | Owner | Due |',
      '| --- | :-: | --: |',
      `| API ${n} | Bo | Mon |`,
      `| UI ${n} | Ana | Tue |`,
      `| Tests ${n} | Cy | Wed |`,
      '',
      '```ts',
      `export function route${n}(app: App): void {`,
      `  app.get('/m${n}', (c) => c.json({ ok: true }));`,
      '}',
      '```',
      '',
      `> Keep module ${n} small; split it when it grows.`,
      '',
    );
  }
  return { text: parts.join('\n'), sections };
}

describe('SafeMarkdown: a real 60 KB plan draws fully formatted (IR-REL051-A34-1)', () => {
  it(
    'every heading, list, table and code block is drawn; nothing falls to plain text',
    { timeout: DRAIN_TIMEOUT_MS },
    async () => {
      const { text, sections } = realisticPlan();
      expect(text.length).toBeGreaterThan(59_000);
      const start = performance.now();
      md(text);
      const took = performance.now() - start;
      expect(drawn()).toBeLessThanOrEqual(SLICE_ELEMENTS_MAX);
      const { slowest, slices, mostAdded } = await drain();
      expect(slices).toBeLessThanOrEqual(SLICES_MAX);
      expect(mostAdded).toBeLessThanOrEqual(SLICE_ELEMENTS_MAX);
      expect(took).toBeLessThan(WALL_CLOCK_CEILING_MS);
      expect(slowest).toBeLessThan(WALL_CLOCK_CEILING_MS);
      expect(host.querySelector('.al-md-rest')).toBeNull();
      expect(host.querySelectorAll('h4')).toHaveLength(sections);
      expect(host.querySelectorAll('h5')).toHaveLength(sections);
      expect(host.querySelectorAll('table')).toHaveLength(sections);
      expect(host.querySelectorAll('pre code')).toHaveLength(sections);
      expect(host.querySelectorAll('blockquote')).toHaveLength(sections);
      expect(host.querySelectorAll('ol > li > ul > li > ul > li')).toHaveLength(2 * sections);
      expect(host.textContent).toContain(`Keep module ${String(sections)} small`);
      assertInert();
    },
  );
});

describe('SafeMarkdown: hostile input stays inert (REL051-A34, I-5)', () => {
  it('REL051-R2C (R2-CLASS-07): task-list items show a read-only box, never a form element', () => {
    md(['- [ ] todo one', '- [x] done two', '- plain three'].join('\n'));
    const boxes = [...host.querySelectorAll('[role="checkbox"]')];
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    for (const b of boxes) expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).not.toContain('[ ]');
    expect(host.textContent).not.toContain('[x]');
    expect(host.textContent).toContain('todo one');
    expect(host.querySelectorAll('li')).toHaveLength(3);
    assertInert();
  });

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

  // IR-REL051-A34-1 (M1, M2, lows): every pathological 256 KB input draws a bounded first slice and
  // under 50 000 elements; past the document budget the rest is plain text with a short note.
  // REL051-CIE: the bound is counted (elements), with a coarse wall-clock ceiling as a second guard.
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
  it.each(Object.keys(BUDGET_CASES))(
    '%s: a bounded first slice, under 50 000 elements, under the wall-clock ceiling',
    (name) => {
      const text = BUDGET_CASES[name] as string;
      const start = performance.now();
      md(text);
      const took = performance.now() - start;
      expect(drawn()).toBeLessThanOrEqual(SLICE_ELEMENTS_MAX);
      expect(drawn()).toBeLessThan(50_000);
      expect(took).toBeLessThan(WALL_CLOCK_CEILING_MS);
      assertInert();
    },
  );

  it('says when the rest is shown as plain text, and keeps that text', async () => {
    md(`${fill('- a\n')}\nLAST LINE`);
    await drain();
    expect(host.textContent).toContain('The rest of this file is shown as plain text.');
    expect(host.textContent).toContain('LAST LINE');
  });

  // IR-REL051-A34-1 follow-up: the rest of a document draws in later slices; every slice is
  // bounded too, and the whole stays under the hard cap.
  it.each(['list items', 'repeated 2000-row tables', 'links', 'paragraphs', 'emphasis'])(
    '%s, drawn to the end: each slice bounded, few slices, the whole under 50 000 elements',
    { timeout: DRAIN_TIMEOUT_MS },
    async (name) => {
      md(BUDGET_CASES[name] as string);
      expect(drawn()).toBeLessThanOrEqual(SLICE_ELEMENTS_MAX);
      // One long paragraph is one piece (capped by itself); the others draw in several slices.
      const { slowest, slices, mostAdded } = await drain();
      expect(slices).toBeLessThanOrEqual(SLICES_MAX);
      expect(mostAdded).toBeLessThanOrEqual(SLICE_ELEMENTS_MAX);
      expect(slowest).toBeLessThan(WALL_CLOCK_CEILING_MS);
      expect(drawn()).toBeLessThan(50_000);
      expect(host.querySelector('.al-md')?.getAttribute('aria-busy')).toBe('false');
      assertInert();
    },
  );

  it('stops drawing when it goes away (the reader closed mid-document)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    md(fill('- a\n'));
    expect(host.querySelector('.al-md')?.getAttribute('aria-busy')).toBe('true');
    act(() => root.render(h('div')));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(host.querySelector('.al-md')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
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

  it('renders 256 KB of empty lines under 50 000 elements and the wall-clock ceiling', () => {
    for (const kind of ['text', 'patch'] as const) {
      const start = performance.now();
      act(() => root.render(h(SafeCode, { text: '\n'.repeat(256 * 1024), kind })));
      expect(performance.now() - start, kind).toBeLessThan(WALL_CLOCK_CEILING_MS);
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
