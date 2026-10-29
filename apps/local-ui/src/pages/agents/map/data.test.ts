// U3-map: the map's rules as pure functions (b11 §32.2 to §32.4): who is drawn, in what order, how
// many streams, what words. No message content exists in these inputs.
import { describe, expect, it } from 'vitest';
import type { ContactRow } from '../../contacts/data.js';
import type { Pulse } from '../../pulse/data.js';
import type { AgentRow } from '../data.js';
import {
  buildMap,
  flowPath,
  mergeFlow,
  parseFlow,
  type ContactFlow,
  type FlowItem,
} from './data.js';

const NOW = 1_800_000_000;
const ref = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const agent = (name: string, over: Partial<AgentRow> = {}): AgentRow => ({
  name,
  label: name,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  apps: [],
  ...over,
});
const contact = (n: number, over: Partial<ContactRow> = {}): ContactRow => ({
  ref: ref(n),
  name: `Person ${String(n)}`,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
  ...over,
});
type Act = 'active_now' | 'today' | 'quiet';
const counts = (n: number): number[] => [...Array.from({ length: 11 }, () => 0), n];
function pulseOf(entries: [number, number, Act][]): Pulse {
  return {
    now: NOW,
    partial: false,
    contacts: new Map(
      entries.map(([n, total, activity]) => [
        ref(n),
        { contactId: ref(n), counts: counts(total), lastAt: NOW - n, activity },
      ]),
    ),
  };
}
const item = (n: number, over: Partial<FlowItem> = {}): FlowItem => ({
  contactId: ref(n),
  direction: 'out',
  kind: 'message',
  state: 'sent',
  at: NOW - 5,
  ...over,
});
const NO_FLOW: ReadonlyMap<string, ContactFlow> = new Map();
const base = {
  agents: [agent('a', { current: true, label: 'Personal', apps: ['Claude Code'] })],
  contacts: [] as ContactRow[],
  pulse: undefined as Pulse | undefined,
  flow: NO_FLOW,
  nowSec: NOW,
  showQuiet: false,
};

describe('flow parsing and merging', () => {
  it('flowPath: no since, or whole seconds', () => {
    expect(flowPath()).toBe('/api/ui/flow');
    expect(flowPath(12)).toBe('/api/ui/flow?since=12');
  });

  it('parseFlow keeps an exact key set and drops bad items', () => {
    const flow = parseFlow({
      now: NOW,
      cursor: String(NOW - 60),
      partial: false,
      items: [
        { ...item(1), text: 'SECRET' },
        { ...item(2), state: 'received' },
        { ...item(3), direction: 'in', state: 'received' },
        { contactId: 'x' },
      ],
    });
    expect(flow?.items).toHaveLength(2);
    expect(JSON.stringify(flow)).not.toContain('SECRET');
    expect(parseFlow({ now: 'x' })).toBeUndefined();
  });

  it('mergeFlow keeps the newest per contact and direction', () => {
    const m1 = mergeFlow(NO_FLOW, [item(1, { at: NOW - 30 })]);
    const m2 = mergeFlow(m1, [
      item(1, { at: NOW - 5 }),
      item(1, { direction: 'in', state: 'received' }),
    ]);
    expect(m2.get(ref(1))?.out?.at).toBe(NOW - 5);
    expect(m2.get(ref(1))?.in).toBeDefined();
    expect(mergeFlow(m2, [item(1, { at: NOW - 100 })]).get(ref(1))?.out?.at).toBe(NOW - 5);
  });
});

describe('buildMap', () => {
  it('shows at most 12 contacts per agent and counts the rest', () => {
    const contacts = Array.from({ length: 15 }, (_, i) => contact(i + 1));
    const pulse = pulseOf(contacts.map((_, i) => [i + 1, 3, 'today']));
    const m = buildMap({ ...base, contacts, pulse });
    expect(m.contacts).toHaveLength(12);
    expect(m.moreContacts).toBe(3);
  });

  it('shows at most 8 agents and counts the rest', () => {
    const agents = [
      agent('a', { current: true }),
      ...Array.from({ length: 9 }, (_, i) => agent(`x${String(i)}`)),
    ];
    const m = buildMap({ ...base, agents });
    expect(m.agents).toHaveLength(8);
    expect(m.moreAgents).toBe(2);
  });

  it('hides quiet contacts until Show quiet, and sorts by activity', () => {
    const contacts = [contact(1), contact(2), contact(3)];
    const pulse = pulseOf([
      [1, 0, 'quiet'],
      [2, 2, 'today'],
      [3, 9, 'active_now'],
    ]);
    const hidden = buildMap({ ...base, contacts, pulse });
    expect(hidden.contacts.map((c) => c.ref)).toEqual([ref(3), ref(2)]);
    expect(hidden.quietHidden).toBe(1);
    const shown = buildMap({ ...base, contacts, pulse, showQuiet: true });
    expect(shown.contacts.map((c) => c.ref)).toEqual([ref(3), ref(2), ref(1)]);
  });

  it('names: owner-confirmed only, others are "Unnamed contact"', () => {
    const m = buildMap({
      ...base,
      contacts: [contact(1), contact(2, { nameSource: 'counterparty', name: 'Mallory' })],
      pulse: pulseOf([
        [1, 1, 'today'],
        [2, 1, 'today'],
      ]),
    });
    expect(m.contacts.map((c) => c.name).sort()).toEqual(['Person 1', 'Unnamed contact']);
  });

  it('line weight follows the count (1 to 3) and a line needs an exchange in 24 hours', () => {
    const contacts = [contact(1), contact(2), contact(3)];
    const pulse = pulseOf([
      [1, 12, 'today'],
      [2, 1, 'today'],
      [3, 0, 'quiet'],
    ]);
    const m = buildMap({ ...base, contacts, pulse, showQuiet: true });
    const by = (n: number) => m.contacts.find((c) => c.ref === ref(n));
    expect(by(1)?.weight).toBe(3);
    expect(by(2)?.weight).toBe(1);
    expect(by(3)?.line).toBe(false);
    expect(by(1)?.line).toBe(true);
  });

  it('direction: both ways, one way, unknown', () => {
    const contacts = [contact(1), contact(2), contact(3)];
    const pulse = pulseOf([
      [1, 3, 'today'],
      [2, 3, 'today'],
      [3, 3, 'today'],
    ]);
    const flow = mergeFlow(NO_FLOW, [
      item(1, { at: NOW - 500 }),
      item(1, { direction: 'in', state: 'received', at: NOW - 600 }),
      item(2, { at: NOW - 500 }),
    ]);
    const m = buildMap({ ...base, contacts, pulse, flow });
    const by = (n: number) => m.contacts.find((c) => c.ref === ref(n));
    expect(by(1)?.direction).toBe('both');
    expect(by(2)?.direction).toBe('out');
    expect(by(3)?.direction).toBe('unknown');
  });

  it('streams only for the last minute, at most 6, at most 2 animated', () => {
    const contacts = Array.from({ length: 8 }, (_, i) => contact(i + 1));
    const pulse = pulseOf(contacts.map((_, i) => [i + 1, 3, 'active_now']));
    const flow = mergeFlow(
      NO_FLOW,
      contacts.map((_, i) => item(i + 1, { at: NOW - i })),
    );
    const m = buildMap({ ...base, contacts, pulse, flow });
    expect(m.streams).toBe(6);
    expect(m.contacts.filter((c) => c.stream)).toHaveLength(6);
    expect(m.contacts.filter((c) => c.animate)).toHaveLength(2);
    expect(m.contacts.filter((c) => c.moving !== undefined)).toHaveLength(8);
    const old = buildMap({
      ...base,
      contacts,
      pulse,
      flow: mergeFlow(NO_FLOW, [item(1, { at: NOW - 61 })]),
    });
    expect(old.streams).toBe(0);
  });

  it('a failed delivery is not moving', () => {
    const m = buildMap({
      ...base,
      contacts: [contact(1)],
      pulse: pulseOf([[1, 1, 'today']]),
      flow: mergeFlow(NO_FLOW, [item(1, { state: 'not_delivered' })]),
    });
    expect(m.contacts[0]?.moving).toBeUndefined();
  });

  it('summary: counts and who is talking, with plurals', () => {
    const one = buildMap({ ...base, contacts: [contact(1)], pulse: pulseOf([[1, 1, 'today']]) });
    expect(one.summary).toBe('1 agent, 1 contact.');
    const talking = buildMap({
      ...base,
      agents: [agent('a', { current: true, label: 'Personal' }), agent('b')],
      contacts: [contact(1), contact(2)],
      pulse: pulseOf([
        [1, 1, 'today'],
        [2, 1, 'today'],
      ]),
      flow: mergeFlow(NO_FLOW, [item(1)]),
    });
    expect(talking.summary).toBe('2 agents, 2 contacts. Person 1 is talking with Personal now.');
  });
});
