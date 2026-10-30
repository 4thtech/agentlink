// W4-SHELL (Decision 44 B1, b11 §34.2): the agent's letter icon. Until an icon set exists, an agent
// is drawn as its initial in a coloured circle. The colour comes from a fixed palette of token pairs
// and is chosen by the agent's stable key, so it never changes on a rename and never depends on
// anything but that key. The icon is decorative: the label is always next to it as text.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import css from './components.css?raw';
import {
  AGENT_DOT_STATES,
  AGENT_ICON_TONES,
  AgentIcon,
  agentIconTone,
  agentInitial,
} from './agent-icon.js';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);

describe('AgentIcon (W4-SHELL, Decision 44 B1)', () => {
  it('shows the first letter of the label, upper case, and is hidden from assistive tech', () => {
    const out = html(h(AgentIcon, { label: 'side project', seed: 'work' }));
    expect(out).toMatch(/^<span[^>]*aria-hidden="true"[^>]*>S<\/span>$/);
    expect(out).toContain('al-agent-icon');
  });

  it('takes the first whole character, skipping spaces, and falls back to ?', () => {
    expect(agentInitial('  ana')).toBe('A');
    expect(agentInitial('élan')).toBe('É');
    expect(agentInitial('🦊 fox')).toBe('🦊');
    expect(agentInitial('')).toBe('?');
    expect(agentInitial('   ')).toBe('?');
  });

  it('picks the same tone for the same key every time, and only tones of the palette', () => {
    expect(AGENT_ICON_TONES.length).toBeGreaterThanOrEqual(5);
    for (const key of ['default', 'work', 'agent-2', 'Personal', '']) {
      const tone = agentIconTone(key);
      expect(AGENT_ICON_TONES).toContain(tone);
      expect(agentIconTone(key)).toBe(tone);
    }
  });

  it('spreads keys over the palette (not one colour for everyone)', () => {
    const seen = new Set(
      ['default', 'work', 'personal', 'test', 'side', 'agent-2', 'agent-3', 'cc'].map(
        agentIconTone,
      ),
    );
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('keys the colour on the seed, so a rename keeps it', () => {
    const before = html(h(AgentIcon, { label: 'Ana', seed: 'default' }));
    const after = html(h(AgentIcon, { label: 'Ana Studio', seed: 'default' }));
    expect(before.replace('>A<', '')).toBe(after.replace('>A<', ''));
  });

  it('renders a label from another party as text only (I-5)', () => {
    const out = html(h(AgentIcon, { label: '<img src=x>', seed: 'x' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;');
  });

  it('has one style per tone, drawn from design tokens only, in two sizes', () => {
    for (const tone of AGENT_ICON_TONES) {
      const rule = new RegExp(`\\.al-agent-icon\\.is-${tone}\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, tone).not.toBeNull();
      expect(rule?.[1]).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
      expect(rule?.[1]).toMatch(/var\(--al-color-/);
    }
    expect(css).toMatch(/\.al-agent-icon\.is-lg\s*\{/);
    expect(html(h(AgentIcon, { label: 'A', seed: 'a', size: 'lg' }))).toContain('is-lg');
  });

  it('W4-SHELL-V2: draws the live dot in the corner only when asked, one class per state', () => {
    expect(html(h(AgentIcon, { label: 'Work' }))).not.toContain('al-agent-icon-dot');
    for (const dot of AGENT_DOT_STATES) {
      const out = html(h(AgentIcon, { label: 'Work', seed: 'work', size: 'lg', dot }));
      expect(out).toContain(`al-agent-icon-dot is-${dot}`);
      // Still decoration only: the whole icon stays hidden, and the letter is still the text.
      expect(out).toMatch(/^<span[^>]*aria-hidden="true"/);
      expect(out.replace(/<[^>]+>/g, '')).toBe('W');
    }
    for (const rule of [
      '.al-agent-icon-dot',
      '.al-agent-icon-dot.is-ready',
      '.al-agent-icon-dot.is-none',
    ]) {
      expect(css).toContain(rule);
    }
  });
});
