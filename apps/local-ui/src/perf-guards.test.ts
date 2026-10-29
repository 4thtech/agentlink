// UI-REFRESH-t (a, b): static guards for the performance fixes measured in the UI-REFRESH-q audit
// (4x CPU, headless Chromium). The numbers are in the card's PR; these keep the causes from coming
// back. They read the stylesheets as text.
import { describe, expect, it } from 'vitest';
import activity from './pages/activity/activity.css?raw';
import map from './pages/agents/map/map.css?raw';
import agentsPage from './pages/agents/index.tsx?raw';
import messages from './pages/messages/messages.css?raw';

const squash = (css: string): string =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();

function block(css: string, selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const text = squash(css);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if ((m[1] as string).split(',').some((s) => s.trim() === selector)) return m[2] as string;
  }
  return '';
}

describe('Messages scrolling (b)', () => {
  it('buttons inside the messages change colour at once, not with a fade', () => {
    // A resting pointer crosses a button on every row while the page scrolls; each colour fade
    // repainted the scroller and dropped a frame at 4x CPU.
    expect(block(messages, '.ms-item .al-btn')).toMatch(/transition:\s*none/);
  });
});

describe('Activity first render (a)', () => {
  it('day sections far off screen are not laid out or painted', () => {
    const r = block(activity, '.al-activity-section');
    expect(r).toMatch(/content-visibility:\s*auto/);
    expect(r).toMatch(/contain-intrinsic-size:\s*auto\s/);
  });
});

describe('Live connections map (U3-map, b11 §32.4)', () => {
  const text = squash(map);
  it('animates only stroke-dashoffset and transform, and never loops', () => {
    const frames = [...text.matchAll(/@keyframes [\w-]+ \{(.*?\}) \}/g)].map((m) => m[1] as string);
    expect(frames.length).toBeGreaterThan(0);
    for (const body of frames) {
      const props = [...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      for (const p of props) expect(['stroke-dashoffset', 'transform']).toContain(p);
    }
    expect(text).not.toMatch(/infinite/);
    expect(text).not.toMatch(/transition:\s*all/);
  });
  it('is switched off under reduced motion', () => {
    expect(text).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*animation: none/);
    expect(text).toMatch(/data-motion='reduced'\] \.mp-stream-run/);
  });
  it('is loaded lazily, never with the list', () => {
    expect(agentsPage).toMatch(/import\('\.\/map\/index\.js'\)/);
    expect(agentsPage).not.toMatch(/^import .* from '\.\/map\//m);
  });
});
