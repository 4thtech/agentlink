import type { SuiteModule } from '../suite';
import { bip340 } from './bip340';
import { eip712 } from './eip712';
import { fingerprint } from './fingerprint';
import { hkdfDerive } from './hkdf-derive';
import { jcs } from './jcs';
import { nip44 } from './nip44';
import { placeholderSha256 } from './placeholder-sha256';
import { taggedHashSuite } from './tagged-hash';

/**
 * Suite name (= directory under test-vectors/) to suite module. A vector file without one fails,
 * unless the suite is listed in test-vectors/pending-suites.json (M1-1h); a suite listed there that
 * also has a module fails too, so the card that adds the module removes the pending entry.
 */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['bip340', bip340],
  ['eip712', eip712],
  ['fingerprint', fingerprint],
  ['hkdf-derive', hkdfDerive],
  ['jcs', jcs],
  ['nip44', nip44],
  ['placeholder-sha256', placeholderSha256],
  ['tagged-hash', taggedHashSuite],
]);
