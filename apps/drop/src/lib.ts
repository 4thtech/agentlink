// The drop's library surface (CHORE-DROP-ENTRY-EXPORTS): the shared constants, helpers and types that
// tests and other code import directly, kept off the Worker entry module (index.ts).
export { DropState } from './state.js';
export { DEFAULTS, readConfig, type DropConfig, type Limits } from './config.js';
export { ipBucket } from './ip.js';
export { METRICS, type Metric } from './state.js';
export type { DropEnv } from './worker.js';

export const packageName = '@4thtech-io/drop';
