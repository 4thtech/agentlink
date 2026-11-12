// UI-REFRESH-u: the Settings pages and the Under the hood panel load on first use in the app. Unit
// tests render them at once, so they are loaded here, before any test file runs. The lazy behaviour
// itself is tested in lazy/lazy.test.tsx, which resets nothing and uses its own parts.
// W4-SHELL: the agents list a view read last is module state (it outlives a view mounted again after
// a switch); every test starts without one.
import { beforeEach } from 'vitest';
import { loadHood } from './lazy/hood.js';
import { loadAllPages } from './lazy/pages.js';
import { resetAgentsCacheForTests } from './pages/agents/use-agents.js';
import { resetLiveForTests } from './api/live.js';
import { resetUiSettingsForTests } from './prefs/ui-settings.js';
import { resetNoticesForTests } from './notices/index.js';

// The sensor's name follows the platform (11 §5: Touch ID / Windows Hello / "your passkey"; see
// presence-word.ts). jsdom reports the runner's OS, so every test starts as a Mac browser, the words
// the tests assert; a test that checks another platform sets its own navigator after this runs.
// AGENTLINK_TEST_UA overrides it (to reproduce another runner).
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const useDefaultBrowser = (): void => {
  if (typeof navigator === 'undefined') return;
  const ua = process.env['AGENTLINK_TEST_UA'] ?? MAC_UA;
  const set = (key: string, value: unknown): void => {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  };
  set('userAgent', ua);
  set('userAgentData', undefined);
};

await Promise.all([loadAllPages(), loadHood()]);
beforeEach(() => {
  useDefaultBrowser();
  resetAgentsCacheForTests();
  // W4-SHELL-V2: the shared live store and the app's UI settings are module state too.
  resetLiveForTests();
  resetUiSettingsForTests();
  // notices.md: remembered dismissals and archived connections are module state too.
  resetNoticesForTests();
});
