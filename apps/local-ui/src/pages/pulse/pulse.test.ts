// UX2-f2: the pulse read, the 24-hour bars, the words and the "Most active" order (b11 §24; D-137).
import { lintVocabulary } from '@4thtech-io/ui';
import { describe, expect, it } from 'vitest';
import activityCss from './pulse.css?raw';
import {
  PULSE_PATH,
  activityRank,
  barHeights,
  compareMostActive,
  parsePulse,
  pulseSummary,
  type PulseContact,
} from './data.js';
import { PULSE_STRINGS as S } from './strings.js';

const NOW = 1_760_000_000;
const flat = (): number[] => Array.from({ length: 12 }, () => 0);
const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  contactId: 'c-marko',
  counts: flat(),
  lastAt: NOW - 60,
  activity: 'active_now',
  ...extra,
});
const wire = (contacts: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  now: NOW,
  bucketSeconds: 7200,
  partial: false,
  contacts,
  ...extra,
});

describe('the read', () => {
  it('uses the one pulse route and nothing else', () => {
    expect(PULSE_PATH).toBe('/api/ui/messages/pulse');
  });

  it('parses an answer into a lookup by contact', () => {
    const p = parsePulse(wire([entry()]));
    expect(p?.partial).toBe(false);
    expect(p?.now).toBe(NOW);
    expect(p?.contacts.get('c-marko')).toEqual({
      contactId: 'c-marko',
      counts: flat(),
      lastAt: NOW - 60,
      activity: 'active_now',
    });
  });

  it('copies only the allowed fields (I-5): a field the server should not send never gets through', () => {
    const p = parsePulse(wire([entry({ text: 'CANARY-TEXT', name: 'CANARY-NAME' })]));
    expect(JSON.stringify([...(p?.contacts.values() ?? [])])).not.toContain('CANARY');
  });

  it('leaves out an entry with a bad shape and keeps the rest', () => {
    const p = parsePulse(
      wire([
        entry({ counts: [1, 2, 3] }),
        entry({ contactId: 'c-two', activity: 'online' }),
        entry({ contactId: 'c-three', counts: [...flat().slice(1), -1] }),
        entry({ contactId: 'c-four', lastAt: 'now' }),
        entry({ contactId: 'c-ok', activity: 'today' }),
      ]),
    );
    expect([...(p?.contacts.keys() ?? [])]).toEqual(['c-ok']);
  });

  it('refuses an answer that is not an answer', () => {
    expect(parsePulse(null)).toBeUndefined();
    expect(parsePulse({ items: [] })).toBeUndefined();
    expect(parsePulse(wire([], { now: 'x' }))).toBeUndefined();
  });

  it('carries partial through', () => {
    expect(parsePulse(wire([], { partial: true }))?.partial).toBe(true);
  });
});

describe('the bars (b11 §24.2)', () => {
  it('draws an empty bucket as a 1 px baseline, so the 24 hours always show', () => {
    expect(barHeights(flat())).toEqual(flat().map(() => 1));
  });

  it('scales to the larger of the busiest bucket and 4: one message does not fill the row', () => {
    const c = flat();
    c[11] = 1;
    expect(barHeights(c)[11]).toBe(4);
    expect(barHeights(c)[10]).toBe(1);
  });

  it('gives the busiest bucket the full 16 px and a bucket with a count at least 2 px', () => {
    const c = flat();
    c[3] = 1;
    c[11] = 20;
    const h = barHeights(c);
    expect(h[11]).toBe(16);
    expect(h[3]).toBe(2);
  });

  it('summarises in words, not bar by bar', () => {
    const c = flat();
    c[0] = 4;
    c[11] = 10;
    expect(pulseSummary(c)).toBe('14 messages in the last 24 hours');
    expect(pulseSummary(flat())).toBe('No messages in the last 24 hours');
    const one = flat();
    one[5] = 1;
    expect(pulseSummary(one)).toBe('1 message in the last 24 hours');
  });
});

describe('the words and the order', () => {
  const c = (id: string, activity: PulseContact['activity'], lastAt: number): PulseContact => ({
    contactId: id,
    counts: flat(),
    lastAt,
    activity,
  });

  it('says Active now, Today and Quiet, never Online', () => {
    expect(S.activeNow).toBe('Active now');
    expect(S.today).toBe('Today');
    expect(S.quiet).toBe('Quiet');
    expect(JSON.stringify(S)).not.toMatch(/online/i);
    expect(S.mostActive).toBe('Most active');
    expect(S.recent).toBe('Recent');
    expect(S.sortLabel).toBe('Sort');
  });

  it('keeps every string clear of the words 11 §5 rules out', () => {
    for (const v of Object.values(S)) {
      const text = typeof v === 'function' ? v(3) : v;
      expect(lintVocabulary(text)).toEqual([]);
    }
  });

  it('ranks Active now before Today before Quiet', () => {
    expect(activityRank('active_now')).toBeLessThan(activityRank('today'));
    expect(activityRank('today')).toBeLessThan(activityRank('quiet'));
  });

  it('orders by activity, then the most recent exchange', () => {
    const list = [
      c('quiet-new', 'quiet', NOW - 90_000),
      c('today-old', 'today', NOW - 5000),
      c('today-new', 'today', NOW - 900),
      c('active', 'active_now', NOW - 10),
    ];
    list.sort(compareMostActive);
    expect(list.map((x) => x.contactId)).toEqual(['active', 'today-new', 'today-old', 'quiet-new']);
  });
});

describe('the styles (b11 §24)', () => {
  it('has nothing that loops', () => {
    expect(activityCss).not.toMatch(/infinite/);
  });
  it('draws the pulse 47 by 16 and forced colours use CanvasText', () => {
    expect(activityCss).toMatch(/47px/);
    expect(activityCss).toMatch(/16px/);
    expect(activityCss).toMatch(/forced-colors: active[\s\S]*CanvasText/);
  });
  it('uses no orange: that colour means "this needs you"', () => {
    expect(activityCss).not.toMatch(/accent|warning/);
  });
  it('has a narrow layout where the word moves under the name and the pulse stays', () => {
    expect(activityCss).toMatch(/@media \(max-width: 479px\)/);
  });
});
