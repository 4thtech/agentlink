// The submitter's library surface (CHORE-SUBMITTER-WRANGLER-DEV): the package name and the shared
// routes, Durable Object factories, settings and constants of worker.ts, for tests and other code.
// The Worker entry module (index.ts) exports only what the Workers runtime expects, because
// Wrangler refuses an entry module with other exports.
export const packageName = '@4thtech-io/submitter';
export * from './worker.js';
