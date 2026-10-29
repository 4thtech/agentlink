// U3-h (b11 §29): the Agents read, ordering, the switcher's truncation and the Tidy up count.
import { describe, expect, it } from 'vitest';
import { appsText, orderAgents, parseAgents, shortLabel, tidyCandidates } from './data.js';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'default',
  label: 'Personal',
  current: false,
  available: true,
  removing: false,
  contacts: 2,
  running: false,
  apps: [],
  ...over,
});

describe('parseAgents', () => {
  it('reads the app host list', () => {
    const list = parseAgents({
      switchable: true,
      generation: 4,
      current: 'default',
      label: 'Personal',
      agents: [row({ current: true, apps: ['Claude Code'] }), row({ name: 'work', label: 'Work' })],
    });
    expect(list?.switchable).toBe(true);
    expect(list?.generation).toBe(4);
    expect(list?.agents).toHaveLength(2);
    expect(list?.agents[0]?.apps).toEqual(['Claude Code']);
  });
  it('reads "not switchable" outside the app host', () => {
    expect(parseAgents({ switchable: false, agents: [] })).toEqual({
      switchable: false,
      current: null,
      label: null,
      agents: [],
    });
  });
  it('refuses a body of the wrong shape and drops a bad row', () => {
    expect(parseAgents('x')).toBeUndefined();
    expect(parseAgents({ switchable: true, generation: 'a', agents: [] })).toBeUndefined();
    const list = parseAgents({
      switchable: true,
      generation: 1,
      current: null,
      label: null,
      agents: [row(), { name: 5 }, null],
    });
    expect(list?.agents).toHaveLength(1);
  });
  it('keeps a label as plain text, never trimmed into markup handling', () => {
    const list = parseAgents({
      switchable: true,
      generation: 1,
      current: null,
      label: null,
      agents: [row({ label: '<img src=x onerror=alert(1)>' })],
    });
    expect(list?.agents[0]?.label).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('ordering and wording', () => {
  const a = (over: Record<string, unknown>) =>
    parseAgents({
      switchable: true,
      generation: 1,
      current: null,
      label: null,
      agents: [row(over)],
    })!.agents[0]!;
  it('puts the open agent first, then by label, removals last', () => {
    const rows = [
      a({ name: 'z', label: 'Zed' }),
      a({ name: 'o', label: 'Old', removing: true }),
      a({ name: 'w', label: 'Work' }),
      a({ name: 'p', label: 'Personal', current: true }),
    ];
    expect(orderAgents(rows).map((r) => r.name)).toEqual(['p', 'w', 'z', 'o']);
  });
  it('truncates the trigger label at 20 characters', () => {
    expect(shortLabel('Personal')).toBe('Personal');
    expect(shortLabel('A'.repeat(25))).toBe(`${'A'.repeat(19)}…`);
  });
  it('names the AI apps, "+1" for more, and the none case', () => {
    expect(appsText(a({ apps: [] }))).toBe('Not connected to an AI app');
    expect(appsText(a({ apps: ['Codex'] }))).toBe('Codex');
    expect(appsText(a({ apps: ['Claude Code', 'Codex'] }))).toBe('Claude Code +1');
  });
  it('counts Tidy up agents: no AI app, no contacts, removal not finished excluded', () => {
    const rows = [
      a({ name: 'a', contacts: 0 }),
      a({ name: 'b', contacts: 0, apps: ['Codex'] }),
      a({ name: 'c', contacts: 3 }),
      a({ name: 'd', contacts: 0, removing: true }),
      a({ name: 'e', contacts: null }),
    ];
    expect(tidyCandidates(rows).map((r) => r.name)).toEqual(['a']);
  });
});
