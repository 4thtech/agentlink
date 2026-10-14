import type { SuiteModule } from '../suite';
import { aeadEnvelope } from './aead-envelope';
import { bip340 } from './bip340';
import { fingerprint } from './fingerprint';
import { hkdfDerive } from './hkdf-derive';
import { hpke } from './hpke';
import { jcs } from './jcs';
import { placeholderSha256 } from './placeholder-sha256';
import { taggedHashSuite } from './tagged-hash';

/**
 * Suite name (= directory under test-vectors/) to suite module. A vector file without one fails,
 * unless the suite is listed in test-vectors/pending-suites.json (M1-1h); a suite listed there that
 * also has a module fails too, so the card that adds the module removes the pending entry.
 */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['aead-envelope', aeadEnvelope],
  ['bip340', bip340],
  ['fingerprint', fingerprint],
  ['hkdf-derive', hkdfDerive],
  ['hpke', hpke],
  ['jcs', jcs],
  ['placeholder-sha256', placeholderSha256],
  ['tagged-hash', taggedHashSuite],
]);
