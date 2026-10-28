// @vitest-environment jsdom
// UX2-h (S1): the compact view's data, copy and opener (b11 §25; UX-WAVE-2 item 5, decision 5.1).
// - The pulse read is checked before use (counts and times only; anything else is dropped).
// - Most active order: 24-hour count, then the newest exchange (§24.5); top five, then "+n more".
// - The opener is window.open with a small size; no server route, no token in the address (08 §1).
import { describe, expect, it, vi } from 'vitest';
import compactCss from './compact.css?raw';
import { PULSE_PATH, barHeights, parsePulse, pulseTotal, rankByActivity, TOP_N } from './data.js';
import {
  COMPACT_FEATURES,
  COMPACT_NAME,
  COMPACT_PATH,
  openCompactWindow,
  openInMainApp,
} from './open.js';
import { COMPACT_STRINGS as S, moreContacts, pulseLabel } from './strings.js';
import type { ContactRow } from '../contacts/data.js';

const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const flat = (): number[] => Array.from({ length: 12 }, () => 0);

describe('parsePulse', () => {
  it('keeps contact, twelve counts, last time and the activity word', () => {
    const counts = flat();
    counts[11] = 3;
    const out = parsePulse({
      now: 1_000_000,
      bucketSeconds: 7200,
      partial: false,
      contacts: [{ contactId: ref(1), counts, lastAt: 999_900, activity: 'active_now' }],
    });
    expect(out?.now).toBe(1_000_000);
    expect(out?.rows).toEqual([{ ref: ref(1), counts, lastAt: 999_900, activity: 'active_now' }]);
  });

  it('drops anything else in an item, such as message text', () => {
    const out = parsePulse({
      now: 5,
      contacts: [
        {
          contactId: ref(1),
          counts: flat(),
          lastAt: 1,
          activity: 'today',
          text: 'SECRET',
          name: 'x',
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(Object.keys(out?.rows[0] ?? {}).sort()).toEqual(['activity', 'counts', 'lastAt', 'ref']);
  });

  it('leaves out malformed items and rejects a malformed answer', () => {
    expect(parsePulse(null)).toBeUndefined();
    expect(parsePulse({ now: 'x', contacts: [] })).toBeUndefined();
    expect(parsePulse({ now: 1, contacts: 'no' })).toBeUndefined();
    const out = parsePulse({
      now: 1,
      contacts: [
        { contactId: 'bad', counts: flat(), lastAt: 1, activity: 'today' },
        { contactId: ref(2), counts: [1, 2], lastAt: 1, activity: 'today' },
        { contactId: ref(3), counts: flat(), lastAt: 1, activity: 'online' },
        { contactId: ref(4), counts: flat(), lastAt: -1, activity: 'today' },
        { contactId: ref(5), counts: flat(), lastAt: 1, activity: 'quiet' },
      ],
    });
    expect(out?.rows.map((r) => r.ref)).toEqual([ref(5)]);
  });

  it('reads the route the node serves', () => {
    expect(PULSE_PATH).toBe('/api/ui/messages/pulse');
  });
});

const contact = (n: number, name = `C${String(n)}`): ContactRow => ({
  ref: ref(n),
  name,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
});

describe('rankByActivity', () => {
  it('orders by 24-hour count, then the newest exchange, then name', () => {
    const c1 = flat();
    c1[11] = 2;
    const c2 = flat();
    c2[3] = 5;
    const c3 = flat();
    c3[11] = 2;
    const pulse = parsePulse({
      now: 100,
      contacts: [
        { contactId: ref(1), counts: c1, lastAt: 50, activity: 'today' },
        { contactId: ref(2), counts: c2, lastAt: 10, activity: 'today' },
        { contactId: ref(3), counts: c3, lastAt: 90, activity: 'today' },
      ],
    });
    const ranked = rankByActivity(
      [contact(4, 'Zed'), contact(1), contact(2), contact(3)],
      pulse?.rows ?? [],
    );
    expect(ranked.map((r) => r.contact.name)).toEqual(['C2', 'C3', 'C1', 'Zed']);
    expect(pulseTotal(ranked[0]?.pulse?.counts ?? [])).toBe(5);
  });

  it('works without a pulse read, and skips blocked and revoked contacts', () => {
    const blocked = { ...contact(9), status: 'blocked' as const };
    const ranked = rankByActivity([blocked, contact(1)], []);
    expect(ranked.map((r) => r.contact.name)).toEqual(['C1']);
    expect(ranked[0]?.pulse).toBeUndefined();
  });

  it('shows five at most', () => {
    expect(TOP_N).toBe(5);
  });
});

describe('barHeights (b11 §24.2)', () => {
  it('scales per row by the larger of the busiest bar and 4, with a 2 px minimum', () => {
    const counts = flat();
    counts[0] = 1;
    counts[11] = 2;
    const h = barHeights(counts);
    expect(h).toHaveLength(12);
    expect(h[11]).toBe(8); // 2 / 4 * 16
    expect(h[0]).toBe(4); // 1 / 4 * 16
    expect(h[5]).toBe(1); // empty bucket: a 1 px baseline
  });

  it('never goes under 2 px for a bar with a count, and tops out at 16', () => {
    const counts = flat();
    counts[1] = 1;
    counts[2] = 100;
    const h = barHeights(counts);
    expect(h[2]).toBe(16);
    expect(h[1]).toBe(2);
  });
});

describe('copy', () => {
  it('has the new strings of §25', () => {
    expect(S.openCompact).toBe('Open compact window');
    expect(S.mostActive).toBe('Most active');
    expect(S.openApp).toBe('Open AgentLink');
    expect(moreContacts(12)).toBe('+12 more');
    expect(S.title).toBe('AgentLink');
  });

  it('names the pulse as one image', () => {
    expect(pulseLabel(14)).toBe('14 messages in the last 24 hours');
    expect(pulseLabel(1)).toBe('1 message in the last 24 hours');
    expect(pulseLabel(0)).toBe('No messages in the last 24 hours');
  });

  it('uses none of the never-say words (11 §5.1)', () => {
    const NEVER =
      /wallet|seed phrase|transaction|\bgas\b|blockchain|on-chain|relay|nostr|hash|token|mcp|online/i;
    const all = [...Object.values(S), moreContacts(3), pulseLabel(2)].join(' | ');
    expect(all).not.toMatch(NEVER);
  });
});

describe('opening the window', () => {
  it('opens a small separate window at a path the server already serves', () => {
    expect(COMPACT_PATH).toBe('/settings/compact');
    expect(COMPACT_FEATURES).toContain('width=380');
    expect(COMPACT_FEATURES).toContain('height=600');
    const open = vi.fn(() => ({ focus: vi.fn() }));
    openCompactWindow({ open } as unknown as Window);
    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0] as unknown as [string, string, string];
    expect(url).toBe(COMPACT_PATH);
    expect(name).toBe(COMPACT_NAME);
    expect(features).toBe(COMPACT_FEATURES);
    // 08 §1: nothing in the address but the path.
    expect(url).not.toMatch(/[?#=]/);
  });

  it('openInMainApp uses the opener when it is open, else a named window', () => {
    const assignTarget = {
      history: { pushState: vi.fn() },
      dispatchEvent: vi.fn(),
      focus: vi.fn(),
      closed: false,
    };
    const withOpener = { opener: assignTarget, open: vi.fn() } as unknown as Window;
    openInMainApp('/', withOpener);
    expect(assignTarget.history.pushState).toHaveBeenCalled();
    expect(assignTarget.focus).toHaveBeenCalled();
    expect(withOpener.open).not.toHaveBeenCalled();

    const alone = { opener: null, open: vi.fn(() => ({ focus: vi.fn() })) } as unknown as Window;
    openInMainApp('/', alone);
    expect(alone.open).toHaveBeenCalledTimes(1);
  });
});

describe('stylesheet', () => {
  it('uses tokens only: no literal durations, no looping animation, no inline-style hooks', () => {
    expect(compactCss).not.toMatch(/(?:transition|animation)[^;]*\b\d+m?s\b/);
    expect(compactCss).not.toMatch(/infinite/);
    expect(compactCss).not.toMatch(
      /(?:transition|animation)[^;]*\b(?:width|height|top|left|margin)\b/,
    );
  });
});
