// L1: connected is green. A connected AI app with no recent tool call (live state `idle`) reads
// "Connected", so its dot is the same filled green dot as `ready`, not the "Not connected" ring.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LIVE_WORDS } from '../api/live.js';
import { LiveDot } from './agent-switcher.js';
import css from './shell.css?raw';

describe('idle live dot (L1)', () => {
  it('says Connected, like ready', () => {
    expect(LIVE_WORDS.idle).toBe(LIVE_WORDS.ready);
  });

  it('gets the class of the filled dot, and the filled style is shared with ready', () => {
    expect(renderToStaticMarkup(h(LiveDot, { state: 'idle' }))).toContain('al-ldot is-idle');
    const dot =
      /\.al-ldot\.is-working,\s*\.al-ldot\.is-ready,\s*\.al-ldot\.is-idle\s*\{([^}]*)\}/.exec(css);
    expect(dot?.[1]).toMatch(/background:\s*var\(--al-color-status-success-icon\)/);
    expect(css).toMatch(
      /\.al-am-app-word\.is-working,\s*\.al-am-app-word\.is-ready,\s*\.al-am-app-word\.is-idle\s*\{/,
    );
  });

  it('keeps the ring for off', () => {
    expect(css).not.toMatch(/\.al-ldot\.is-off[^{]*\{[^}]*background/);
  });
});
