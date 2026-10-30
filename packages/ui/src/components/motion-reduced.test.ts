// W4-MOTION-KIT fix round (IR-W4-MOTION-KIT-1 M1): reduced motion means FADES ONLY (owner, 30 Oct).
// The global switch at the top of motion.css stops every element animation with `!important`; the
// kit's reveals, menus, pops, crossfades, the skeleton reveal and the no-View-Transition route enter
// must still fade (opacity, the fade token), under the system setting and the app's own data-motion.
// The check draw stays instant (a stroke, not a fade).
import { describe, expect, it } from 'vitest';
import motionCss from './motion.css?raw';

const flat = motionCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

const FADERS = [
  '.al-reveal',
  '.al-expand',
  '.al-menu',
  '.al-slide-in',
  '.al-pop',
  '.al-crossfade',
  '.al-skel-reveal',
  '.al-route',
];
const FADE =
  'animation: al-fade-in var(--al-duration-fade) var(--al-easing-standard) both !important;';
const OPTIMISTIC =
  'transition: opacity var(--al-duration-fade) var(--al-easing-standard) !important;';

/** The declarations of the rule whose selector list holds exactly `selectors`, inside `scope`. */
function ruleBody(scope: string, selectors: string[]): string | null {
  const list = selectors.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(', ?');
  const m = new RegExp(`(?:^|[{};]) ?${list} \\{ ([^}]*)\\}`).exec(scope);
  return m === null ? null : (m[1] as string).trim();
}

const mediaBlocks = (): string[] => {
  const out: string[] = [];
  const re = /@media \(prefers-reduced-motion: reduce\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < flat.length && depth > 0; i += 1) {
      if (flat[i] === '{') depth += 1;
      if (flat[i] === '}') depth -= 1;
    }
    out.push(flat.slice(m.index + m[0].length, i - 1));
  }
  return out;
};

describe('reduced motion fades the kit moments (both switches)', () => {
  it('under prefers-reduced-motion: every moment fades with the fade token', () => {
    const bodies = mediaBlocks()
      .map((b) => ruleBody(b, FADERS))
      .filter((b): b is string => b !== null);
    expect(bodies).toContain(FADE);
    const opt = mediaBlocks()
      .map((b) => ruleBody(b, ['.al-optimistic']))
      .filter((b): b is string => b !== null);
    expect(opt).toContain(OPTIMISTIC);
  });

  it("under the app's data-motion='reduced': the same fades", () => {
    const scoped = FADERS.map((s) => `:root[data-motion='reduced'] ${s}`);
    expect(ruleBody(flat, scoped)).toBe(FADE);
    expect(ruleBody(flat, [":root[data-motion='reduced'] .al-optimistic"])).toBe(OPTIMISTIC);
  });

  it('the fade moves opacity only', () => {
    expect(flat).toMatch(/@keyframes al-fade-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  });

  it('the check draw stays instant (no fade rule names it)', () => {
    expect(flat).not.toMatch(/\.al-draw[^{]*\{ animation: al-fade-in/);
  });
});
