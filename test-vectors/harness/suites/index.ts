import type { SuiteModule } from '../suite';
import { aeadEnvelope } from './aead-envelope';
import { bip340 } from './bip340';
import { cardPop } from './card-pop';
import { dropAuth } from './drop-auth';
import { eip712 } from './eip712';
import { eip712Proof } from './eip712-proof';
import { eip712Revocation } from './eip712-revocation';
import { encodings } from './encodings';
import { fingerprint } from './fingerprint';
import { hkdfDerive } from './hkdf-derive';
import { hpke } from './hpke';
import { inviteLink } from './invite-link';
import { jcs } from './jcs';
import { keystoreFile } from './keystore-file';
import { nip44 } from './nip44';
import { ownerAction } from './owner-action';
import { ownerWrap } from './owner-wrap';
import { pairing } from './pairing';
import { pairingBodies } from './pairing-bodies';
import { placeholderSha256 } from './placeholder-sha256';
import { prfWrap } from './prf-wrap';
import { recoveryKit } from './recovery-kit';
import { safetyCode } from './safety-code';
import { safetyCodeRecompute } from './safety-code-recompute';
import { stream } from './stream';
import { taggedHashSuite } from './tagged-hash';
import { terms } from './terms';
import { ucd15Table } from './ucd15-table';

/**
 * Suite name (= directory under test-vectors/) to suite module. A vector file without one fails,
 * unless the suite is listed in test-vectors/pending-suites.json (M1-1h); a suite listed there that
 * also has a module fails too, so the card that adds the module removes the pending entry.
 */
export const suiteModules: ReadonlyMap<string, SuiteModule> = new Map([
  ['aead-envelope', aeadEnvelope],
  ['bip340', bip340],
  ['card-pop', cardPop],
  ['drop-auth', dropAuth],
  ['eip712', eip712],
  ['eip712-proof', eip712Proof],
  ['eip712-revocation', eip712Revocation],
  ['encodings', encodings],
  ['fingerprint', fingerprint],
  ['hkdf-derive', hkdfDerive],
  ['hpke', hpke],
  ['invite-link', inviteLink],
  ['jcs', jcs],
  ['keystore-file', keystoreFile],
  ['nip44', nip44],
  ['owner-action', ownerAction],
  ['owner-wrap', ownerWrap],
  ['pairing', pairing],
  ['pairing-bodies', pairingBodies],
  ['placeholder-sha256', placeholderSha256],
  ['prf-wrap', prfWrap],
  ['recovery-kit', recoveryKit],
  ['safety-code', safetyCode],
  ['safety-code-recompute', safetyCodeRecompute],
  ['stream', stream],
  ['tagged-hash', taggedHashSuite],
  ['terms', terms],
  ['ucd15-table', ucd15Table],
]);
