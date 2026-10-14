import type { SuiteModule } from '../suite';
import { aeadEnvelope } from './aead-envelope';
import { bip340 } from './bip340';
import { eip712 } from './eip712';
import { fingerprint } from './fingerprint';
import { hkdfDerive } from './hkdf-derive';
import { hpke } from './hpke';
import { jcs } from './jcs';
import { keystoreFile } from './keystore-file';
import { nip44 } from './nip44';
import { ownerWrap } from './owner-wrap';
import { pairing } from './pairing';
import { placeholderSha256 } from './placeholder-sha256';
import { safetyCode } from './safety-code';
import { taggedHashSuite } from './tagged-hash';

/**
 * Suite name (= directory under test-vectors/) to suite module. A vector file without one fails,
 * unless the suite is listed in test-vectors/pending-suites.json (M1-1h); a suite listed there that
 * also has a module fails too, so the card that adds the module removes the pending entry.
 */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['aead-envelope', aeadEnvelope],
  ['bip340', bip340],
  ['eip712', eip712],
  ['fingerprint', fingerprint],
  ['hkdf-derive', hkdfDerive],
  ['hpke', hpke],
  ['jcs', jcs],
  ['keystore-file', keystoreFile],
  ['nip44', nip44],
  ['owner-wrap', ownerWrap],
  ['pairing', pairing],
  ['placeholder-sha256', placeholderSha256],
  ['safety-code', safetyCode],
  ['tagged-hash', taggedHashSuite],
]);
