// @vitest-environment jsdom
// HOTFIX-045-TOPBAR (B8): one status in the top bar, no "+N" overflow chip, the agent's own name.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPrefsForTests } from '../prefs/index.js';
import { resetAgentsCacheForTests } from '../pages/agents/use-agents.js';
import { AgentSwitcher } from './agent-switcher.js';
import { connectionChip } from './top-bar.js';
import type { ConnectionState } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const agents = (running: boolean) => ({
  switchable: true,
  generation: 3,
  current: 'default',
  label: 'Personal',
  agents: [
    {
      name: 'default',
      label: 'Personal',
      current: true,
      available: true,
      removing: false,
      contacts: 2,
      running,
      apps: ['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'Windsurf'],
    },
  ],
});

beforeEach(() => {
  resetAgentsCacheForTests();
  window.localStorage.clear();
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetPrefsForTests();
});

async function mount(connection: ConnectionState, running: boolean): Promise<void> {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response(JSON.stringify(agents(running)), { status: 200 })),
  );
  await act(async () => {
    // W4-SHELL: the one chip lives in the agent switcher, top left.
    root.render(h(AgentSwitcher, { chip: connectionChip(connection) }));
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('HOTFIX-045-TOPBAR: the top bar', () => {
  it('shows exactly one status chip, never "Connected" next to "Not running"', async () => {
    await mount('connected', false);
    expect(host.querySelectorAll('.al-livedot')).toHaveLength(1);
  });

  it('shows one status chip when everything runs', async () => {
    await mount('connected', true);
    expect(host.querySelectorAll('.al-livedot')).toHaveLength(1);
  });

  it('tells the browser being offline in the one chip', async () => {
    await mount('offline', true);
    expect(host.querySelectorAll('.al-livedot')).toHaveLength(1);
    expect(host.textContent).toContain('Not connected');
  });

  it('has no "+N" overflow chip for the AI apps', async () => {
    await mount('connected', true);
    expect(host.textContent ?? '').not.toMatch(/\+\d/);
    const trigger = host.querySelector('.ag-switch-btn');
    expect(trigger?.getAttribute('aria-label') ?? '').not.toMatch(/\+\d/);
  });

  it("names the agent by its own name, not the computer's", async () => {
    await mount('connected', true);
    const trigger = host.querySelector('.ag-switch-btn');
    expect(trigger?.querySelector('.ag-switch-label')?.textContent).toBe('Personal');
    expect(trigger?.getAttribute('aria-label')).toContain('Personal');
  });
});
