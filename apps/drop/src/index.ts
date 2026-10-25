// The Worker entry module wrangler.toml deploys (CHORE-DROP-ENTRY-EXPORTS). Wrangler refuses an entry
// with exports the runtime does not expect, so this exports only the fetch handler and the Durable
// Object class its binding names. Shared constants, helpers and types live in lib.ts.
export { default } from './worker.js';
export { DropState } from './state.js';
