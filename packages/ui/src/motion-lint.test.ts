// UI-REFRESH-a (S1): the motion lint (plan §4, owner decision: no motion library, only opacity and
// transform animate). It reads every stylesheet of packages/ui and apps/local-ui and fails when
//   1. a `transition` or `@keyframes` animates anything but opacity, transform or stroke-dashoffset
//      (named exception: the row-leave height collapse, B-11 §6 row 4),
//   2. a duration is a literal instead of a token (`var(--al-duration-…)`, or a `calc()` of one),
//   3. a stylesheet animates without a reduced-motion rule (`@media (prefers-reduced-motion: …)`
//      or `[data-motion='reduced']`). `motion.css` holds the one global switch for both.
// The exceptions below are exact: a stale one fails too, so later cards must delete theirs.
import { describe, expect, it } from 'vitest';

interface Node {
  prelude: string;
  decls: [string, string][];
  children: Node[];
}

/** A small CSS reader: nested blocks with a prelude and declarations. Comments are dropped. */
function parse(css: string): Node {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root: Node = { prelude: '', decls: [], children: [] };
  const stack: Node[] = [root];
  let buf = '';
  let paren = 0;
  const flush = (): void => {
    const s = buf.trim();
    buf = '';
    const i = s.indexOf(':');
    if (s === '' || i < 0) return;
    const top = stack[stack.length - 1] as Node;
    top.decls.push([s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]);
  };
  for (const ch of text) {
    if (ch === '(') paren += 1;
    if (ch === ')') paren -= 1;
    if (paren === 0 && ch === '{') {
      const node: Node = { prelude: buf.trim().replace(/\s+/g, ' '), decls: [], children: [] };
      (stack[stack.length - 1] as Node).children.push(node);
      stack.push(node);
      buf = '';
    } else if (paren === 0 && ch === ';') {
      flush();
    } else if (paren === 0 && ch === '}') {
      flush();
      if (stack.length > 1) stack.pop();
    } else {
      buf += ch;
    }
  }
  return root;
}

const ALLOWED = new Set(['opacity', 'transform', 'stroke-dashoffset']);
const KEYFRAME_OK = new Set([...ALLOWED, 'animation-timing-function']);
const KEYWORDS = new Set([
  'none',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'infinite',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'initial',
  'inherit',
  'unset',
]);

/** Split on a separator that is not inside parentheses. */
function splitTop(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim() !== '') out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

const LITERAL_TIME = /^-?(\d+\.?\d*|\.\d+)m?s$/i;
const isTime = (t: string): boolean =>
  LITERAL_TIME.test(t) || t.startsWith('var(--al-duration') || t.startsWith('calc(');
/** The first time in a shorthand is the duration (the second is a delay and may be a literal). */
function literalDuration(tokens: string[]): string | null {
  const first = tokens.find(isTime);
  return first !== undefined && LITERAL_TIME.test(first) ? first : null;
}

interface Hit {
  file: string;
  kind: 'keyframes-property' | 'transition-property' | 'literal-duration' | 'no-reduced-motion';
  where: string;
  what: string;
}
const id = (h: Hit): string => `${h.file} | ${h.kind} | ${h.where} | ${h.what}`;

/** The row-leave height collapse is the one named property exception. */
const propertyOk = (prop: string, where: string): boolean =>
  ALLOWED.has(prop) || (prop === 'height' && /row-leave/.test(where));

function lintMotion(files: Record<string, string>): Hit[] {
  const hits: Hit[] = [];
  for (const [file, css] of Object.entries(files)) {
    let animates = false;
    let hasReducedRule = false;
    const visit = (node: Node, inKeyframes: string | null): void => {
      const p = node.prelude;
      if (/^@media[^{]*prefers-reduced-motion/i.test(p) || /\[data-motion=['"]?reduced/.test(p)) {
        hasReducedRule = true;
      }
      const kf = /^@keyframes\s+([\w-]+)/i.exec(p);
      const frames = kf !== null ? (kf[1] as string) : inKeyframes;
      if (kf !== null) animates = true;
      for (const [prop, value] of node.decls) {
        if (frames !== null) {
          if (!KEYFRAME_OK.has(prop) && !propertyOk(prop, frames)) {
            hits.push({ file, kind: 'keyframes-property', where: frames, what: prop });
          }
          continue;
        }
        if (prop === 'transition' || prop === 'transition-property') {
          for (const seg of splitTop(value, ',')) {
            const tokens = splitTop(seg, ' ');
            const property = (tokens[0] ?? '').toLowerCase();
            if (property !== 'none' && !propertyOk(property, p)) {
              hits.push({ file, kind: 'transition-property', where: p, what: property });
            }
            const lit = prop === 'transition' ? literalDuration(tokens) : null;
            if (lit !== null) hits.push({ file, kind: 'literal-duration', where: p, what: lit });
          }
        }
        if (prop === 'transition-duration' || prop === 'animation-duration') {
          for (const t of splitTop(value, ',')) {
            if (LITERAL_TIME.test(t)) {
              hits.push({ file, kind: 'literal-duration', where: p, what: t });
            }
          }
        }
        if (prop === 'animation') {
          for (const seg of splitTop(value, ',')) {
            const tokens = splitTop(seg, ' ');
            const name = tokens.find(
              (t) => !isTime(t) && !KEYWORDS.has(t) && !t.includes('(') && !/^\d/.test(t),
            );
            if (name === undefined) continue; // `animation: none`
            animates = true;
            const lit = literalDuration(tokens);
            if (lit !== null) hits.push({ file, kind: 'literal-duration', where: name, what: lit });
          }
        }
      }
      for (const c of node.children) visit(c, frames);
    };
    visit(parse(css), null);
    if (animates && !hasReducedRule) {
      hits.push({ file, kind: 'no-reduced-motion', where: '*', what: 'animation' });
    }
  }
  return [...new Map(hits.map((h) => [id(h), h])).values()];
}

// The named exceptions: exactly these, each with its owner card. Not for new code.
const NAMED_EXCEPTIONS: Record<string, string> = {
  // Shimmer moves to --al-duration-ambient-sweep in UI-REFRESH-j.
  'apps/local-ui/src/pages/files/files.css | literal-duration | fl-shimmer | 1.4s': 'UI-REFRESH-j',
  'apps/local-ui/src/pages/files/files.css | keyframes-property | fl-shimmer | background-position':
    'UI-REFRESH-j',
};
// Colour and position transitions that predate the lint (plain hover and switch states). They are
// listed so nothing new joins them; the page and component cards remove them as they restyle.
const LEGACY_EXCEPTIONS: Record<string, string> = {
  'packages/ui/src/components/components.css | transition-property | .al-btn | background-color':
    'legacy',
  'packages/ui/src/components/components.css | transition-property | .al-btn | border-color':
    'legacy',
  'packages/ui/src/components/components.css | transition-property | .al-switch-knob | left':
    'legacy',
  'apps/local-ui/src/pages/files/files.css | transition-property | .fl-tab | color': 'legacy',
  'apps/local-ui/src/pages/files/files.css | transition-property | .fl-tab | border-color':
    'legacy',
};

/** Stylesheet text by repo-relative path, from the two places the app's CSS lives. */
const raw = import.meta.glob(['./**/*.css', '../../../apps/local-ui/src/**/*.css'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const sheets: Record<string, string> = {};
for (const [key, text] of Object.entries(raw)) {
  const path = key.startsWith('./')
    ? `packages/ui/src/${key.slice(2)}`
    : key.replace(/^(\.\.\/)+/, '');
  sheets[path] = text;
}

describe('motion lint on the real stylesheets', () => {
  it('finds the stylesheets it is meant to lint', () => {
    for (const f of [
      'packages/ui/src/components/components.css',
      'packages/ui/src/tokens/tokens.css',
      'apps/local-ui/src/pages/files/files.css',
      'apps/local-ui/src/pages/messages/messages.css',
      'apps/local-ui/src/pages/contacts/contacts.css',
    ]) {
      expect(Object.keys(sheets), f).toContain(f);
    }
  });

  it('passes with exactly the named exceptions and the legacy list, and no stale entry', () => {
    const found = lintMotion(sheets).map(id).sort();
    expect(found).toEqual(
      [...Object.keys(NAMED_EXCEPTIONS), ...Object.keys(LEGACY_EXCEPTIONS)].sort(),
    );
  });

  it('names exactly the named exception left (the files.css shimmer, UI-REFRESH-j)', () => {
    const files = new Set(Object.keys(NAMED_EXCEPTIONS).map((k) => k.split(' | ')[0]));
    expect([...files].sort()).toEqual(['apps/local-ui/src/pages/files/files.css']);
    expect(
      Object.keys(NAMED_EXCEPTIONS).filter((k) => k.includes('literal-duration')),
    ).toHaveLength(1);
  });

  it('every animating stylesheet has a reduced-motion rule, and motion.css holds the global switch', () => {
    expect(lintMotion(sheets).filter((h) => h.kind === 'no-reduced-motion')).toEqual([]);
    const motion = sheets['packages/ui/src/components/motion.css'] ?? '';
    expect(motion).toContain("[data-motion='reduced']");
  });
});

describe('motion lint on fixtures', () => {
  const FIX = 'fixture.css';
  const reduced = '@media (prefers-reduced-motion: reduce) { .a { animation: none; } }';
  const run = (css: string): string[] => lintMotion({ [FIX]: css }).map(id);

  it('fails a keyframe that animates width', () => {
    const css = `@keyframes grow { from { width: 0; } to { width: 10px; } } .a { animation: grow var(--al-duration-base) linear; } ${reduced}`;
    expect(run(css)).toContain(`${FIX} | keyframes-property | grow | width`);
  });

  it('fails a transition on width, height, box-shadow, all and a colour', () => {
    for (const prop of ['width', 'height', 'box-shadow', 'all', 'background-color', 'left']) {
      expect(run(`.a { transition: ${prop} var(--al-duration-fast) ease; }`), prop).toContain(
        `${FIX} | transition-property | .a | ${prop}`,
      );
    }
  });

  it('fails a literal duration in a transition, an animation and a longhand', () => {
    expect(run('.a { transition: opacity 200ms ease; }')).toContain(
      `${FIX} | literal-duration | .a | 200ms`,
    );
    expect(
      run(
        `@keyframes spin { to { transform: rotate(1turn); } } .a { animation: spin 1.2s linear infinite; } ${reduced}`,
      ),
    ).toContain(`${FIX} | literal-duration | spin | 1.2s`);
    expect(run('.a { transition-duration: 0.3s; }')).toContain(
      `${FIX} | literal-duration | .a | 0.3s`,
    );
  });

  it('passes opacity, transform and stroke-dashoffset with token durations', () => {
    const css = `@keyframes draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
      @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      .a { transition: opacity var(--al-duration-fast) var(--al-easing-standard), transform calc(var(--al-duration-fast) * 2) ease; }
      .b { animation: draw var(--al-duration-moment) var(--al-easing-emphasized) both, rise var(--al-duration-base) ease 400ms; }
      ${reduced}`;
    expect(run(css)).toEqual([]);
  });

  it('allows the row-leave height collapse and nothing else named height', () => {
    expect(run('.al-row-leave { transition: height var(--al-duration-base) ease; }')).toEqual([]);
    expect(run('.al-row { transition: height var(--al-duration-base) ease; }')).toEqual([
      `${FIX} | transition-property | .al-row | height`,
    ]);
  });

  it('fails an animation without a reduced-motion rule and accepts either form of the rule', () => {
    const base =
      '@keyframes f { to { opacity: 1; } } .a { animation: f var(--al-duration-base) ease; }';
    expect(run(base)).toEqual([`${FIX} | no-reduced-motion | * | animation`]);
    expect(run(`${base} ${reduced}`)).toEqual([]);
    expect(run(`${base} :root[data-motion='reduced'] .a { animation: none; }`)).toEqual([]);
    expect(run(`@media (prefers-reduced-motion: no-preference) { ${base} }`)).toEqual([]);
  });
});
