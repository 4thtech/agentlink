// W4-SHELL-V2 (W4 UX v2 "Live status"): the plain status words from today's agents read. Never
// "Working" without evidence (K1 adds per-app heartbeats; U1-b swaps the poll for its SSE).
import { UI_SETTINGS_SAMPLES, readUiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../pages/agents/data.js';
import { LIVE_WORDS, liveAgent } from './live.js';

const row = (over: Partial<AgentRow>): AgentRow => ({
  name: 'default',
  label: 'Personal',
  current: true,
  available: true,
  removing: false,
  contacts: 1,
  running: true,
  apps: ['Claude Code'],
  ...over,
});

describe('liveAgent', () => {
  it('a running agent is Ready in its first AI app; each app says Ready', () => {
    const a = liveAgent(row({ apps: ['Claude Code', 'Codex'] }));
    expect(a.state).toBe('ready');
    expect(a.statusText).toBe('Ready in Claude Code');
    expect(a.apps.map((x) => `${x.app}:${x.word}`)).toEqual(['Claude Code:Ready', 'Codex:Ready']);
  });

  it('a stopped agent is Not running, and so is each app', () => {
    const a = liveAgent(row({ running: false }));
    expect(a.state).toBe('off');
    expect(a.statusText).toBe(LIVE_WORDS.off);
    expect(a.apps[0]?.state).toBe('off');
  });

  it('an agent with no AI app is Not set up', () => {
    const a = liveAgent(row({ apps: [] }));
    expect(a.state).toBe('none');
    expect(a.statusText).toBe('Not set up');
  });

  it('removal not finished says so', () => {
    expect(liveAgent(row({ removing: true })).statusText).toBe(LIVE_WORDS.removing);
  });

  it('never says Working without a heartbeat', () => {
    for (const running of [true, false]) {
      const a = liveAgent(row({ running }));
      expect(a.state).not.toBe('working');
      expect(a.statusText).not.toContain('Working');
    }
  });
});

describe('the ui-settings contract (the page reads what the app answers)', () => {
  it('reads the samples and refuses every invalid body', () => {
    expect(readUiSettings(UI_SETTINGS_SAMPLES.empty.body)).toEqual({});
    expect(readUiSettings(UI_SETTINGS_SAMPLES.stored.body)).toEqual({
      underTheHood: true,
      menuExpanded: false,
    });
    for (const bad of UI_SETTINGS_SAMPLES.invalid) {
      expect(readUiSettings(bad, 1), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
