// W4-MOTION-KIT (S0): the wave-4 motion tokens, taken from the approved prototype v23 (the page
// change, reveal, press, crossfade and live-dot values). They live in the D1 source, the D1
// stylesheet, the module and the package stylesheet, like the D-132 additions. Spring durations stay
// inside 150 to 350 ms (W4 UX v2, "Motion and perceived speed"); the spring is a CSS `linear()` curve
// that starts at 0 and ends at exactly 1, so a filled animation rests where it should.
import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';
import { motionTokens, scalarTokens } from './index.js';

const d1 = import.meta.glob(
  ['../../../../docs/design/d1/tokens/tokens.css', '../../../../docs/design/d1/tokens/*.json'],
  { query: '?raw', import: 'default', eager: true },
);
const d1Css = d1['../../../../docs/design/d1/tokens/tokens.css'] ?? '';
const source = JSON.parse(d1['../../../../docs/design/d1/tokens/tokens.source.json'] ?? '{}') as {
  duration: { tokens: { name: string; value: string }[] };
  easing: { tokens: { name: string; value: string }[] };
};

const W4 = {
  'al-duration-press': '150ms',
  'al-duration-fade': '160ms',
  'al-duration-exit': '180ms',
  'al-duration-crossfade': '220ms',
  'al-duration-reveal': '300ms',
  'al-duration-page': '340ms',
  'al-duration-shimmer': '1200ms',
  'al-duration-pulse': '1600ms',
  'al-easing-spring':
    'linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1)',
  'al-easing-overshoot': 'cubic-bezier(0.2, 0.9, 0.3, 1.1)',
  'al-easing-pop': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'al-easing-ping': 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

/** The transition durations (the loops, shimmer and pulse, are ambient and longer by design). */
const SPRING_DURATIONS = [
  'al-duration-press',
  'al-duration-fade',
  'al-duration-exit',
  'al-duration-crossfade',
  'al-duration-reveal',
  'al-duration-page',
] as const;

describe('the W4 motion tokens (prototype v23)', () => {
  it('are in the module, both stylesheets and the D1 source with the same values', () => {
    const fromSource = new Map(
      [...source.duration.tokens, ...source.easing.tokens].map((t) => [t.name, t.value]),
    );
    for (const [name, value] of Object.entries(W4)) {
      expect((scalarTokens as Record<string, string>)[name], name).toBe(value);
      expect((motionTokens as Record<string, string>)[name], name).toBe(value);
      expect(css, name).toContain(`--${name}: ${value};`);
      expect(d1Css, name).toContain(`--${name}: ${value};`);
      expect(fromSource.get(name), name).toBe(value);
    }
  });

  it('keeps every transition duration between 150 and 350 ms', () => {
    for (const name of SPRING_DURATIONS) {
      const ms = Number(/^(\d+)ms$/.exec(motionTokens[name])?.[1]);
      expect(ms, name).toBeGreaterThanOrEqual(150);
      expect(ms, name).toBeLessThanOrEqual(350);
    }
  });

  it('has a spring that starts at 0, ends at exactly 1 and has rising stop positions', () => {
    const body = /^linear\((.*)\)$/.exec(motionTokens['al-easing-spring'])?.[1] ?? '';
    const stops = body.split(',').map((s) => s.trim().split(/\s+/));
    expect(stops[0]).toEqual(['0']);
    expect(stops[stops.length - 1]).toEqual(['1']);
    const positions = stops.filter((s) => s.length === 2).map((s) => parseFloat(s[1] as string));
    expect(positions.length).toBeGreaterThan(5);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i] as number).toBeGreaterThan(positions[i - 1] as number);
    }
  });

  it('lists only motion tokens in motionTokens', () => {
    for (const name of Object.keys(motionTokens)) {
      expect(name).toMatch(/^al-(duration|easing)-/);
    }
  });
});
