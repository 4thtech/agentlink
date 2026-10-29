// UI-REFRESH-u: the Settings pages and the Under the hood panel load on first use in the app. Unit
// tests render them at once, so they are loaded here, before any test file runs. The lazy behaviour
// itself is tested in lazy/lazy.test.tsx, which resets nothing and uses its own parts.
// W4-SHELL: the agents list a view read last is module state (it outlives a view mounted again after
// a switch); every test starts without one.
import { beforeEach } from 'vitest';
import { loadHood } from './lazy/hood.js';
import { loadAllPages } from './lazy/pages.js';
import { resetAgentsCacheForTests } from './pages/agents/use-agents.js';

await Promise.all([loadAllPages(), loadHood()]);
beforeEach(() => {
  resetAgentsCacheForTests();
});
