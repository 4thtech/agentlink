// NOTIFY-ALL-IDS (S2; I-5, I-7; 04 §2.5): while the desktop app alerts for one ID, `agentlink mcp` of
// another ID (which already holds that ID's keys and store) raises the OS alert for its new messages
// and files, under the owner's Settings > Notifications switches. Nothing here opens an ID's keys: it
// only reads what the process already holds (flow events: contact ID, kind, time; and owner-given
// names). The text is fixed words plus, only with Show names on, local names that pass the pipe's name
// rule: never message text, a file name, a counterparty's own name or a link.
import { NOTIFY_DEFAULTS } from '@4thtech-io/types/ui-contract/notifications';
import { describe, expect, it } from 'vitest';
import {
  createOtherIdAlerts,
  otherIdLines,
  planOtherIdAlerts,
  type OtherIdEvent,
} from './other-id-alerts.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const ALL = { ...NOTIFY_DEFAULTS, messages: true, files: true };
const ev = (
  contactId: string,
  kind: 'message' | 'file',
  at: number,
  direction: 'in' | 'out' = 'in',
): OtherIdEvent => ({ contactId, kind, at, direction });

describe('planOtherIdAlerts', () => {
  it('the first look only notes what is there (nothing old is alerted)', () => {
    const { news } = planOtherIdAlerts(undefined, [ev(A, 'message', 90)], 100);
    expect(news).toEqual([]);
  });

  it('a new inbound message or file after the first look is news, once', () => {
    const first = planOtherIdAlerts(undefined, [], 100);
    const next = planOtherIdAlerts(first.look, [ev(A, 'message', 105), ev(B, 'file', 106)], 110);
    expect(next.news).toEqual([
      { kind: 'messages', count: 1, ref: A },
      { kind: 'files', count: 1, ref: B },
    ]);
    // The same events read again (the window overlaps) are not news again.
    expect(
      planOtherIdAlerts(next.look, [ev(A, 'message', 105), ev(B, 'file', 106)], 120).news,
    ).toEqual([]);
  });

  it('what we sent is never news', () => {
    const first = planOtherIdAlerts(undefined, [], 100);
    expect(planOtherIdAlerts(first.look, [ev(A, 'message', 105, 'out')], 110).news).toEqual([]);
  });

  it('counts several from one person', () => {
    const first = planOtherIdAlerts(undefined, [], 100);
    const next = planOtherIdAlerts(
      first.look,
      [ev(A, 'message', 105), ev(A, 'message', 105), ev(A, 'message', 106)],
      110,
    );
    expect(next.news).toEqual([{ kind: 'messages', count: 3, ref: A }]);
  });

  it('NOTIFY-DEDUPE shape: a file and its message from one person are one alert (the file)', () => {
    const first = planOtherIdAlerts(undefined, [], 100);
    const next = planOtherIdAlerts(first.look, [ev(A, 'file', 105), ev(A, 'message', 106)], 110);
    expect(next.news).toEqual([{ kind: 'files', count: 1, ref: A }]);
  });

  it('a ref that is not a contact ID is dropped', () => {
    const first = planOtherIdAlerts(undefined, [], 100);
    expect(planOtherIdAlerts(first.look, [ev('../x', 'message', 105)], 110).news).toEqual([]);
  });
});

describe('otherIdLines: fixed words, local sanitised names only (I-5)', () => {
  const news = [{ kind: 'messages' as const, count: 1, ref: A }];

  it('Show names off (the default): no name at all', () => {
    expect(otherIdLines(news, ALL, 'work', new Map([[A, 'Ana']]))).toEqual([
      ['New message', 'There is a new message for another one of your IDs.'],
    ]);
  });

  it('Show names on: the ID name and the owner-given contact name', () => {
    expect(otherIdLines(news, { ...ALL, showNames: true }, 'work', new Map([[A, 'Ana']]))).toEqual([
      ['New message', 'New message for work from Ana.'],
    ]);
  });

  it('a name that is not a plain name is never shown (no link, no markup, no counterparty text)', () => {
    const on = { ...ALL, showNames: true };
    const lines = otherIdLines(news, on, 'work', new Map([[A, 'Click https://x.example now']]));
    expect(lines).toEqual([['New message', 'New message for work.']]);
    const odd = otherIdLines(news, on, 'wo<rk>', new Map([[A, 'Ana']]));
    expect(odd).toEqual([['New message', 'There is a new message for another one of your IDs.']]);
  });

  it('counts and files; the switches decide', () => {
    const on = { ...ALL, showNames: true };
    const many = [
      { kind: 'messages' as const, count: 3, ref: A },
      { kind: 'files' as const, count: 1, ref: B },
    ];
    const names = new Map([
      [A, 'Ana'],
      [B, 'Bo'],
    ]);
    expect(otherIdLines(many, on, 'work', names)).toEqual([
      ['New message', '3 new messages for work from Ana.'],
      ['File received', 'New file for work from Bo.'],
    ]);
    expect(otherIdLines(many, { ...on, messages: false }, 'work', names).length).toBe(1);
    expect(otherIdLines(many, { ...on, messages: false, files: false }, 'work', names)).toEqual([]);
  });
});

describe('createOtherIdAlerts: the runner', () => {
  const make = (opts: { desktop?: string | undefined; prefs?: typeof ALL } = {}) => {
    const shown: (readonly [string, string])[] = [];
    let events: OtherIdEvent[] = [];
    const asked: [number, number][] = [];
    let t = 1000;
    const runner = createOtherIdAlerts({
      agentName: 'work',
      desktopOwner: () => Promise.resolve('desktop' in opts ? opts.desktop : 'personal'),
      prefs: () => Promise.resolve(opts.prefs ?? ALL),
      events: (since, until) => {
        asked.push([since, until]);
        return Promise.resolve({ events, capped: false });
      },
      ownerNames: () => Promise.resolve(new Map([[A, 'Ana']])),
      notify: (lines) => {
        shown.push(lines);
        return Promise.resolve(true);
      },
      now: () => t,
    });
    return {
      runner,
      shown,
      asked,
      push: (...e: OtherIdEvent[]) => (events = [...events, ...e]),
      advance: (s: number) => (t += s),
    };
  };

  it('alerts a new message of this ID while the desktop app alerts for another ID', async () => {
    const m = make();
    await m.runner.tick();
    m.push(ev(A, 'message', 1005));
    m.advance(30);
    await m.runner.tick();
    expect(m.shown).toEqual([
      ['New message', 'There is a new message for another one of your IDs.'],
    ]);
  });

  it('stays quiet when the desktop app alerts for THIS ID (it shows its own) or is not running', async () => {
    for (const desktop of ['work', undefined]) {
      const m = make({ desktop });
      await m.runner.tick();
      m.push(ev(A, 'message', 1005));
      m.advance(30);
      await m.runner.tick();
      expect(m.shown).toEqual([]);
    }
  });

  it("the owner's switch decides, read on each look", async () => {
    const m = make({ prefs: { ...ALL, messages: false } });
    await m.runner.tick();
    m.push(ev(A, 'message', 1005));
    m.advance(30);
    await m.runner.tick();
    expect(m.shown).toEqual([]);
  });

  it('a look that fails alerts nothing and keeps its place', async () => {
    const shown: unknown[] = [];
    let fail = true;
    let t = 1000;
    const runner = createOtherIdAlerts({
      agentName: 'work',
      desktopOwner: () => Promise.resolve('personal'),
      prefs: () => Promise.resolve(ALL),
      events: () =>
        fail
          ? Promise.reject(new Error('x'))
          : Promise.resolve({ events: [ev(A, 'message', 1005)], capped: false }),
      ownerNames: () => Promise.resolve(new Map()),
      notify: (l) => (shown.push(l), Promise.resolve(true)),
      now: () => t,
    });
    await runner.tick();
    fail = false;
    t += 30;
    await runner.tick();
    expect(shown).toEqual([]);
  });

  it('only the process that holds the lease alerts: two instances, one alert', async () => {
    const shown: unknown[] = [];
    let t = 1000;
    let events: OtherIdEvent[] = [];
    const make = (leader: boolean) =>
      createOtherIdAlerts({
        agentName: 'work',
        desktopOwner: () => Promise.resolve('personal'),
        prefs: () => Promise.resolve(ALL),
        events: () => Promise.resolve({ events, capped: false }),
        ownerNames: () => Promise.resolve(new Map()),
        notify: (l) => (shown.push(l), Promise.resolve(true)),
        now: () => t,
        leader: () => leader,
      });
    const a = make(true);
    const b = make(false);
    await Promise.all([a.tick(), b.tick()]);
    events = [ev(A, 'message', 1005)];
    t += 30;
    await Promise.all([a.tick(), b.tick()]);
    expect(shown).toHaveLength(1);
  });

  it('a look that hit the scan cap sends one generic alert, not nothing', async () => {
    const shown: (readonly [string, string])[] = [];
    let t = 1000;
    let capped = false;
    const runner = createOtherIdAlerts({
      agentName: 'work',
      desktopOwner: () => Promise.resolve('personal'),
      prefs: () => Promise.resolve(ALL),
      events: () => Promise.resolve({ events: [], capped }),
      ownerNames: () => Promise.resolve(new Map()),
      notify: (l) => (shown.push(l), Promise.resolve(true)),
      now: () => t,
    });
    await runner.tick();
    capped = true;
    t += 30;
    await runner.tick();
    expect(shown).toEqual([
      ['New messages', 'There are new messages for another one of your IDs.'],
    ]);
  });
});
