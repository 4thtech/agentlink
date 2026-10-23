// zod probes `new Function("")` to compile its parsers, and does so while the schemas of
// @4thtech-io/types are built, that is, while those modules load. This page's CSP forbids it (no
// 'unsafe-eval'; Trusted Types for scripts), so the probe would be reported as a violation on every
// load. The interpreted path is the same parser (packages/types tests that both agree on values and
// issues), so the page switches to it. This module must be imported before anything that loads the
// schemas, and it has no other effect.
import { config } from 'zod';

config({ jitless: true });
