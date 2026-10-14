import type { SuiteModule } from '../suite';
import { placeholderSha256 } from './placeholder-sha256';

/** Suite name (= directory under test-vectors/) to suite module. A vector file without one fails. */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['placeholder-sha256', placeholderSha256],
]);

/**
 * Suites whose vectors are committed before the code under test exists (M1-1h): suite name to the
 * card whose suite module will run them. A pending suite runs no cases; the harness records it as
 * pending in every runtime and `pnpm vectors:check` reports it without failing.
 *
 * Fail closed (tools/vectors/rules.mjs, harness/vectors.test.ts):
 * - a suite listed here that also has a module fails, so the entry must be removed when the module
 *   lands, and from then on every case must pass in every runtime;
 * - an entry without a committed vector file fails;
 * - a pending marker missing in any runtime, or a pending suite with case results, fails.
 */
export const pendingSuites: ReadonlyMap<string, string> = new Map([
  ['jcs', 'M1-1a'],
  ['tagged-hash', 'M1-1a'],
  ['hkdf-derive', 'M1-1b'],
  ['bip340', 'M1-1b'],
  ['hpke', 'M1-1c'],
  ['aead-envelope', 'M1-1c'],
  ['eip712', 'M1-1e'],
  ['pairing', 'M1-1f'],
  ['owner-wrap', 'M1-1f'],
  ['keystore-file', 'M1-1f'],
  ['nip44', 'M1-1g'],
  ['owner-action', 'M1-7d'],
]);
