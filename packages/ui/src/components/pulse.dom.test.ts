// @vitest-environment jsdom
// W4-MOTION-KIT (S0): the live-dot pulse ("a status dot that pulses while Working", prototype v23
// `.al-pulse`). The ring is drawn only while active and motion is not reduced (the system setting or
// the app's data-motion); it pauses while the tab is hidden. The dot is decorative (aria-hidden): the
// caller always says the state in words (never colour alone).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import motionCss from './motion.css?raw';
import { Pulse } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let reducedQuery = false;
beforeEach(() => {
  reducedQuery = false;
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('reduce') ? reducedQuery : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.motion;
});

describe('Pulse', () => {
  it('draws a dot and a ring while active, hidden from screen readers', () => {
    act(() => root.render(h(Pulse, { tone: 'success' })));
    const pulse = host.querySelector('.al-pulse') as HTMLElement;
    expect(pulse.getAttribute('aria-hidden')).toBe('true');
    expect(pulse.dataset.tone).toBe('success');
    expect(pulse.querySelector('.al-pulse-dot')).not.toBeNull();
    expect(pulse.querySelector('.al-pulse-ring')).not.toBeNull();
    expect(host.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('draws no ring when not active', () => {
    act(() => root.render(h(Pulse, { active: false })));
    expect(host.querySelector('.al-pulse-dot')).not.toBeNull();
    expect(host.querySelector('.al-pulse-ring')).toBeNull();
  });

  it('draws no ring under the system reduced-motion setting', () => {
    reducedQuery = true;
    act(() => root.render(h(Pulse)));
    expect(host.querySelector('.al-pulse-dot')).not.toBeNull();
    expect(host.querySelector('.al-pulse-ring')).toBeNull();
  });

  it("draws no ring under the app's own reduced-motion setting, and follows it live", async () => {
    act(() => root.render(h(Pulse)));
    expect(host.querySelector('.al-pulse-ring')).not.toBeNull();
    await act(async () => {
      document.documentElement.dataset.motion = 'reduced';
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector('.al-pulse-ring')).toBeNull();
  });

  it('pauses the ring while the tab is hidden', () => {
    const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => root.render(h(Pulse)));
    expect(host.querySelector('.al-pulse-ring')?.getAttribute('data-paused')).toBe('true');
    spy.mockRestore();
  });
});

describe('the pulse stylesheet', () => {
  const flat = motionCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

  it('pings by transform and opacity with the tokens', () => {
    expect(flat).toMatch(
      /\.al-pulse-ring \{[^}]*animation: al-pulse-ping var\(--al-duration-pulse\) var\(--al-easing-ping\) infinite/,
    );
    expect(flat).toMatch(
      /@keyframes al-pulse-ping \{ 0% \{ transform: scale\(1\); opacity: 0\.65; \} 100% \{ transform: scale\(2\.8\); opacity: 0; \} \}/,
    );
  });

  it('hides the ring under reduced motion, for both switches', () => {
    expect(flat).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.al-pulse-ring \{ animation: none; display: none; \}/,
    );
    expect(flat).toMatch(
      /:root\[data-motion='reduced'\] \.al-pulse-ring \{ animation: none; display: none; \}/,
    );
  });
});
