// UI-REFRESH-u: the Settings pages and the Under the hood panel load on first use in the app. Unit
// tests render them at once, so they are loaded here, before any test file runs. The lazy behaviour
// itself is tested in lazy/lazy.test.tsx, which resets nothing and uses its own parts.
import { loadHood } from './lazy/hood.js';
import { loadAllPages } from './lazy/pages.js';

await Promise.all([loadAllPages(), loadHood()]);
