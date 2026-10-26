// M1-11s-c: owner setup on the first-run page, a passkey creating the owner key (D-120 (1) and its
// follow-up; 04 §2.2, §2.3.1, §2.5, §2.8; 06 §7; 08 §1; I-1, I-4, I-7). Proposed, owner confirms at
// merge.
//
// What it is: the keychain side of the approval server's setup routes (approval-server.ts
// `setupGate`). `begin` creates the owner seed (newOwnerSeed, @4thtech-io/crypto) and holds it in
// server memory; `finish` checks the page's passkey creation response here (checkSetupRegistration)
// and completes the setup in one all-or-nothing operation (completeOwnerSetup):
//
// 0. refuse, before reading or writing anything, a seed that does not derive the owner keys given
//    (the key the page saw as user.id; M1-11s-c-b);
// 1. refuse unless no owner exists anywhere: no card names one, and none of the `owner`,
//    `owner-passkey` and `owner-next` items exists (a partial earlier setup is never reused or
//    overwritten, D-78, 04 §2.8);
// 2. generate an owner code (secretKind 1) and store the seed under it as the `owner` item (`ALKO`),
//    the backup way to approve that every existing owner-code path keeps using;
// 3. when the authenticator returned a PRF output, store the seed under it as the `owner-passkey`
//    item (`ALKP` v1, 04 §2.3.1); without PRF the owner code is the only way (nothing else changes);
// 4. sign the agent's first card with the owner just stored (signFirstCardWith, the `owner init`
//    path: one card for this agent and this owner, read back and verified from core);
// 5. on any failure, remove exactly the items this run stored (passkey first, then the owner item;
//    an item whose bytes are not this run's is never deleted) and report a fixed error.
//
// M1-UX-FIRSTRUN-V2 (D-130 (2); 08 §1 first run v2; 04 §2.5 one owner flow; proposed, owner
// confirms at merge): when the agent's `firstCard.firstPolicy` is given, the same unlocked owner
// session also signs the agent's first policy (the 06 §3 defaults with the real `~/AgentLink/Send`
// allowed, owner-first-policy.ts signFirstPolicy, exactly as `owner init`). The folders are prepared
// by the caller before the gesture (prepareSetupFolders: Send, then Inbox and Proofs, 0700, never
// through a link; a Send folder that is a link at either level, not a folder or not empty is
// refused there, so the setup never starts). If the card is not signed, everything is rolled back
// as before; if the card is signed but the policy is not applied, the owner and the card are kept
// (removing the owner would lock the agent out of its card), no policy is in force, and the caller
// removes the folders this run created (removeSetupFolders).
//
// The owner code is returned once to the caller, which sends it to the page for the collapsed
// "backup way to approve" display and wipes it; it is never logged, put in an event or an error.
// The seed and the PRF output belong to the caller, which wipes them.
//
// Threat note (G-1, D-67; 04 §2.5): the setup routes run in the MCP/CLI process, which the agent
// controls. A same-user process holding a session link (the opener's argv) can race the human and
// set up an owner it controls. If it used the human's one-shot link, the human sees an expired page
// and never a setup step. The signal is: "I never finished a setup, yet approvals are already
// protected" (or the link has expired); the human must then treat the owner as not theirs.
// `agentlink doctor` names the owner fingerprint; the CLI logs a fixed line with the fingerprint of
// an owner set up from the page, and the page shows it after setup, so a human who did finish setup
// can compare. The passkey
// response's attestation statement is not verified ("none"): what is checked binds it to this begin
// (challenge, origin, type), to `localhost` (rpIdHash) and to a gesture with user verification
// (UP, UV), and names the credential the PRF output belongs to. A same-user process can forge all of
// it; it gains nothing it could not get by setting up an owner directly while none exists.
import {
  decodeUtf8,
  encodeBase64url,
  encodeUtf8,
  equalBytes,
  sha256,
  wipe,
  type AgentCard,
  type Argon2idParams,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import { osKeychain, type KeychainBackend } from './keychain.js';
import {
  prepareSendFolder,
  removeCreated,
  type SendFolderPlan,
  type SendFolderResult,
} from './owner-first-policy.js';
import { signFirstCardWith, type FirstAgentCard } from './owner-init.js';
import {
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  removeOwnerItemIfOurs,
  sameOwnerKeys,
  storeOwnerSeed,
  type OwnerItemRemoval,
} from './owner-keystore.js';
import {
  PASSKEY_RP_ID,
  removeOwnerPasskeyItemIfOurs,
  storeOwnerPasskeySeed,
} from './owner-passkey.js';
import { CLI_COMMAND } from './cli-command.js';

/** How long `begin`'s seed is held for `finish` (proposed, owner confirms at merge): 2 minutes. */
export const SETUP_HOLD_MS = 120_000;

const MAX_CREDENTIAL_ID = 1023;
/** rpIdHash (32) ‖ flags (1) ‖ signCount (4) ‖ AAGUID (16) ‖ credIdLen (2), then the ID and key. */
const ATTESTED_HEADER = 55;
const MAX_AUTH_DATA = 1024;
const MAX_CLIENT_DATA = 2048;
const PRF_LENGTH = 32;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
/** The largest finish body: four length-prefixed fields at their limits. */
export const MAX_SETUP_REGISTRATION_BYTES =
  8 + MAX_CREDENTIAL_ID + MAX_AUTH_DATA + MAX_CLIENT_DATA + PRF_LENGTH;

/** What the page sends to `finish` after navigator.credentials.create with `prf.eval`. */
export interface SetupRegistration {
  /** The credential's raw ID, 1..1023 bytes. */
  readonly credentialId: Uint8Array;
  /** `response.getAuthenticatorData()`: with the attested credential data (flag AT). */
  readonly authenticatorData: Uint8Array;
  /** `response.clientDataJSON`, as sent by the browser. */
  readonly clientDataJSON: Uint8Array;
  /** `prf.results.first` (32 bytes), or empty when the authenticator gave none. */
  readonly prfOutput: Uint8Array;
}

const refused = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_refused', 'The passkey response was not accepted.');

/** The binary `finish` body: the four fields, each after its 16-bit big-endian length. */
export function encodeSetupRegistration(registration: SetupRegistration): Uint8Array {
  const fields = [
    registration.credentialId,
    registration.authenticatorData,
    registration.clientDataJSON,
    registration.prfOutput,
  ];
  const out = new Uint8Array(fields.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const field of fields) {
    if (field.length > 0xffff) throw refused();
    out[at] = field.length >> 8;
    out[at + 1] = field.length & 0xff;
    out.set(field, at + 2);
    at += 2 + field.length;
  }
  return out;
}

/**
 * Parses a `finish` body into fresh copies (the caller wipes `bytes` and the PRF output). A malformed
 * body or a field out of bounds is refused, with any copied PRF output wiped.
 */
export function parseSetupRegistration(bytes: Uint8Array): SetupRegistration {
  const out: Uint8Array[] = [];
  let at = 0;
  try {
    for (let i = 0; i < 4; i += 1) {
      if (at + 2 > bytes.length) throw refused();
      const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
      at += 2;
      if (at + length > bytes.length) throw refused();
      out.push(bytes.slice(at, at + length));
      at += length;
    }
    if (at !== bytes.length) throw refused();
    const [credentialId, authenticatorData, clientDataJSON, prfOutput] = out as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    if (
      credentialId.length < 1 ||
      credentialId.length > MAX_CREDENTIAL_ID ||
      authenticatorData.length < ATTESTED_HEADER ||
      authenticatorData.length > MAX_AUTH_DATA ||
      clientDataJSON.length < 1 ||
      clientDataJSON.length > MAX_CLIENT_DATA ||
      (prfOutput.length !== 0 && prfOutput.length !== PRF_LENGTH)
    ) {
      throw refused();
    }
    return Object.freeze({ credentialId, authenticatorData, clientDataJSON, prfOutput });
  } catch (error) {
    wipe(...out);
    throw error;
  }
}

/** What `finish` checks the creation response against: this begin and this server. */
export interface SetupExpectation {
  /** The random challenge `begin` gave the page. */
  readonly challenge: Uint8Array;
  /** `http://localhost:<port>`. */
  readonly origin: string;
}

/**
 * Checks a creation response before its PRF output is used (proposed, owner confirms at merge):
 * clientDataJSON is a `webauthn.create` for this begin's challenge and exactly this origin, not
 * cross-origin; the authenticator data has rpIdHash = SHA-256("localhost") and flags UP, UV and AT;
 * its attested credential ID is the credential ID sent. `owner_operation_refused` otherwise. The
 * attestation statement is not verified (format "none"; see the threat note above).
 */
export function checkSetupRegistration(
  registration: SetupRegistration,
  expected: SetupExpectation,
): void {
  let clientData: unknown;
  try {
    clientData = JSON.parse(decodeUtf8(registration.clientDataJSON));
  } catch {
    throw refused();
  }
  if (typeof clientData !== 'object' || clientData === null || Array.isArray(clientData)) {
    throw refused();
  }
  const data = clientData as Record<string, unknown>;
  if (
    data['type'] !== 'webauthn.create' ||
    data['challenge'] !== encodeBase64url(expected.challenge) ||
    data['origin'] !== expected.origin ||
    (data['crossOrigin'] !== undefined && data['crossOrigin'] !== false) ||
    data['topOrigin'] !== undefined
  ) {
    throw refused();
  }
  const auth = registration.authenticatorData;
  const flags = auth[32] as number;
  if (
    !equalBytes(auth.subarray(0, 32), sha256(encodeUtf8(PASSKEY_RP_ID))) ||
    (flags & FLAG_UP) === 0 ||
    (flags & FLAG_UV) === 0 ||
    (flags & FLAG_AT) === 0
  ) {
    throw refused();
  }
  const idLength = ((auth[53] as number) << 8) | (auth[54] as number);
  if (
    ATTESTED_HEADER + idLength > auth.length ||
    !equalBytes(
      auth.subarray(ATTESTED_HEADER, ATTESTED_HEADER + idLength),
      registration.credentialId,
    )
  ) {
    throw refused();
  }
}

/**
 * IR-M1-11s-c-1 L-6: the file-KeyStore owner files (04 §2.2, §2.8) of this OS user,
 * `~/.agentlink/keystore/owner.alko` and its passkey copy `owner.alkp`. An owner there is an owner
 * too, so setup must not create a second one in the keychain (D-78).
 */
export function defaultOwnerFiles(home: string = homedir()): readonly string[] {
  const dir = join(home, '.agentlink', 'keystore');
  return [join(dir, 'owner.alko'), join(dir, 'owner.alkp')];
}

/** True when anything is at `path` (a file, a link, a folder): only a missing entry is absent. */
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return false;
    // Unreadable: fail closed (the caller refuses setup).
    throw new NodeKeyStoreError('owner_operation_refused', 'The owner files could not be checked.');
  }
}

/** The entry names in `dir`; none when it does not exist. Any other error rejects (fail closed). */
async function entriesOf(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return [];
    throw new NodeKeyStoreError('owner_operation_refused', 'The owner files could not be checked.');
  }
}

/**
 * M1-11b-6 (M1-9i-c restore, 04 §2.3.3 steps 5 and 6; D-78): signs of an owner that has no owner
 * item yet, in the `.agentlink` folder of `ownerFiles` (`<home>/.agentlink/keystore/owner.alko`):
 *
 * - any entry of `agents/` other than `first.name`'s own folder: another agent (added, or restored
 *   from a recovery kit, whose store holds a card naming its owner; a restore writes the agents
 *   before the owner seed), or something a restore left there;
 * - any entry of `keystore/`: an owner file, or another agent's file-KeyStore file or lock (an
 *   imported agent).
 *
 * Folder names only: no file is opened. The CLI's `owner init` text check (owner-on-machine.ts)
 * reads the same folders.
 */
async function otherAgentOrKeystoreEntry(
  ownerFiles: readonly string[],
  ownName: string,
): Promise<boolean> {
  for (const keystore of new Set(ownerFiles.map((file) => dirname(file)))) {
    if ((await entriesOf(keystore)).length > 0) return true;
    const agents = join(dirname(keystore), 'agents');
    if ((await entriesOf(agents)).some((entry) => entry !== ownName)) return true;
  }
  return false;
}

/**
 * True when no owner key exists for this OS user and agent: `first.identity` has no card, none of
 * the `owner`, `owner-passkey` and `owner-next` keychain items exists, none of `ownerFiles` (the
 * file-KeyStore owner files, defaultOwnerFiles) exists, and their `.agentlink` folder holds no other
 * agent and no file-KeyStore entry (otherAgentOrKeystoreEntry). Reads ciphertext only and wipes it;
 * never reads a file's content. A keychain, store or file-system error rejects (callers fail closed).
 */
export async function noOwnerAnywhere(
  keychain: KeychainBackend,
  first: FirstAgentCard,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
  ownerFiles: readonly string[] = defaultOwnerFiles(),
): Promise<boolean> {
  if ((await first.identity.get()) !== undefined) return false;
  for (const account of [OWNER_ACCOUNT, OWNER_PASSKEY_ACCOUNT, OWNER_NEXT_ACCOUNT]) {
    const item = await guarded(() => keychain.get(account), timeoutMs);
    if (item !== null) {
      wipe(item);
      return false;
    }
  }
  for (const path of ownerFiles) {
    if (await entryExists(path)) return false;
  }
  if (await otherAgentOrKeystoreEntry(ownerFiles, first.name)) return false;
  return true;
}

/**
 * M1-11b-6: whether owner setup may be offered for `first` (the CLI wires the first-run page's
 * setup only then): noOwnerAnywhere against `keychain` and `ownerFiles`. Store-only: reads no
 * secret, unlocks nothing. Any error answers false (fail closed: setup is then never wired).
 */
export async function ownerSetupAvailableWith(
  keychain: KeychainBackend,
  first: FirstAgentCard,
  ownerFiles: readonly string[] = defaultOwnerFiles(),
): Promise<boolean> {
  try {
    return await noOwnerAnywhere(keychain, first, KEYCHAIN_CALL_TIMEOUT_MS, ownerFiles);
  } catch {
    return false;
  }
}

/** The package entry (index.ts): ownerSetupAvailableWith against the OS keychain and real home. */
export function ownerSetupAvailable(first: FirstAgentCard): Promise<boolean> {
  return Promise.resolve().then(() => ownerSetupAvailableWith(osKeychain(), first));
}

export interface OwnerSetupInput {
  /** The held owner seed (not modified; the caller wipes it). */
  readonly seed: Uint8Array;
  /** Its public keys. */
  readonly keys: OwnerPublicKeys;
  /** The checked creation response's credential ID. */
  readonly credentialId: Uint8Array;
  /** Its PRF output (32 bytes), or empty (owner code only). Not modified; the caller wipes it. */
  readonly prfOutput: Uint8Array;
  /** The agent whose first card this setup signs. */
  readonly firstCard: FirstAgentCard;
  /**
   * M1-UX-FIRSTRUN-V2: the ready Send folder (prepareSetupFolders) for the first policy, signed with
   * the card when `firstCard.firstPolicy` is given too. Omitted: only the card is signed.
   */
  readonly sendFolder?: Extract<SendFolderPlan, { status: 'ready' }>;
}

export interface OwnerSetupOptions {
  /** Argon2id parameters for the owner code's wrap; default KEYSTORE_KDF_DEFAULTS. */
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
  /** The file-KeyStore owner files to check; default defaultOwnerFiles(). */
  readonly ownerFiles?: readonly string[];
}

export interface OwnerSetupResult {
  /**
   * The first card, signed by the new owner, stored and verified; undefined when `confirmed` is
   * false (core could not be read back after signing).
   */
  readonly card: AgentCard | undefined;
  /**
   * IR-M1-11s-c-1 M-1: false when core could not be read back after signing. The owner is kept
   * (rolling it back could leave a stored card whose owner key is gone, locking the agent), so the
   * owner code is still handed out: the owner is the human's and the code is their way in.
   */
  readonly confirmed: boolean;
  /** The generated owner code (24 characters). Shown once; the caller wipes it. Never logged. */
  readonly ownerCode: Uint8Array;
  /** True when the passkey item was stored too. */
  readonly passkey: boolean;
  /** M1-UX-FIRSTRUN-V2: the first policy, when a Send folder was given (fixed outcome). */
  readonly sendFolder?: SendFolderResult;
}

const ownerExists = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_exists',
    "Approvals are already protected on this computer. AgentLink won't replace that.",
  );

const setupFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_card_failed',
    "Setup didn't finish, so nothing was saved. Start again on this page.",
  );

/** True when `seed` derives exactly `keys`; a malformed seed or key set is false, never thrown. */
function seedIsOwner(seed: Uint8Array, keys: OwnerPublicKeys): boolean {
  try {
    return seed instanceof Uint8Array && sameOwnerKeys(seed, keys);
  } catch {
    return false;
  }
}

/**
 * Completes an owner setup (steps 1 to 5 above), all or nothing. Errors: `owner_exists` (nothing
 * written), `owner_card_failed` (rolled back, or nothing written when `seed` does not derive
 * `keys`, M1-11s-c-b), `keychain_failed` (a rollback delete failed; items may
 * remain). When core cannot be read back after signing, the owner is kept and the result has
 * `confirmed: false` (with the owner code). Error texts are fixed.
 */
export async function completeOwnerSetup(
  keychain: KeychainBackend,
  input: OwnerSetupInput,
  options: OwnerSetupOptions = {},
): Promise<OwnerSetupResult> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const { seed, keys, credentialId, prfOutput, firstCard, sendFolder } = input;
  // M1-11s-c-b: the seed must be the owner whose key the page saw as user.id (`keys`), checked
  // before any keychain read or write. Otherwise a PRF-less setup would store an `owner` item for
  // an owner nobody was shown, and an unconfirmed card read-back would keep it.
  if (!seedIsOwner(seed, keys)) throw setupFailed();
  if (!(await noOwnerAnywhere(keychain, firstCard, timeoutMs, options.ownerFiles))) {
    throw ownerExists();
  }
  const withPasskey = prfOutput.length > 0;
  let ownerBlob: Uint8Array | undefined;
  let passkeyBlob: Uint8Array | undefined;
  const code = generateSecretCode();
  let handedOut = false;

  /** Removes exactly what this run stored; the worst removal outcome. */
  const rollback = async (): Promise<OwnerItemRemoval> => {
    const outcomes: OwnerItemRemoval[] = [];
    if (passkeyBlob !== undefined) {
      outcomes.push(await removeOwnerPasskeyItemIfOurs(keychain, passkeyBlob, timeoutMs));
    }
    if (ownerBlob !== undefined) {
      outcomes.push(await removeOwnerItemIfOurs(keychain, ownerBlob, timeoutMs));
    }
    if (outcomes.includes('failed')) return 'failed';
    return 'removed';
  };

  try {
    try {
      await storeOwnerSeed(
        keychain,
        seed,
        { secret: code, secretKind: 1 },
        {
          timeoutMs,
          ...(options.kdf === undefined ? {} : { kdf: options.kdf }),
          sealed: (blob) => {
            ownerBlob = blob.slice();
          },
        },
      );
      if (withPasskey) {
        await storeOwnerPasskeySeed(keychain, seed, keys, prfOutput, credentialId, {
          timeoutMs,
          sealed: (blob) => {
            passkeyBlob = blob.slice();
          },
        });
      }
    } catch (error) {
      const removal = await rollback();
      if (removal === 'failed') {
        throw new NodeKeyStoreError(
          'keychain_failed',
          `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
        );
      }
      if (error instanceof NodeKeyStoreError && error.code === 'owner_exists') throw ownerExists();
      if (error instanceof NodeKeyStoreError && error.code === 'owner_passkey_exists') {
        throw ownerExists();
      }
      throw setupFailed();
    }
    const outcome = await signFirstCardWith(keychain, keys, code, firstCard, timeoutMs, sendFolder);
    if (outcome.kind === 'signed') {
      handedOut = true;
      // A ready folder whose policy was not attempted (no firstPolicy) is reported as not allowed.
      const policy: SendFolderResult | undefined =
        sendFolder === undefined
          ? undefined
          : (outcome.sendFolder ?? { status: 'not_allowed', reason: 'failed' });
      return Object.freeze({
        card: outcome.card,
        confirmed: true,
        ownerCode: code,
        passkey: withPasskey,
        ...(policy === undefined ? {} : { sendFolder: policy }),
      });
    }
    if (outcome.kind === 'unknown') {
      // IR-M1-11s-c-1 M-1: unknown whether a card names this owner. Keep the owner (a card without
      // its owner key would lock the agent out for good) and hand the owner code out anyway, so the
      // human holds the way into what was created; the page points to `agentlink doctor`.
      handedOut = true;
      return Object.freeze({
        card: undefined,
        confirmed: false,
        ownerCode: code,
        passkey: withPasskey,
        // Whether the policy applied is unknown too: the folders are kept (never a sendable folder
        // removed under a policy that may be in force); the page points to `agentlink doctor`.
        ...(sendFolder === undefined
          ? {}
          : { sendFolder: { status: 'not_confirmed', folder: sendFolder.folder } as const }),
      });
    }
    const removal = await rollback();
    if (removal === 'failed') {
      throw new NodeKeyStoreError(
        'keychain_failed',
        `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
      );
    }
    throw setupFailed();
  } finally {
    if (!handedOut) wipe(code);
    wipe(ownerBlob, passkeyBlob);
  }
}

/** M1-UX-FIRSTRUN-V2: Inbox and Proofs beside Send (08 §1 first run v2; the 06 §3 defaults). */
const OTHER_FOLDERS: readonly string[] = Object.freeze(['Inbox', 'Proofs']);

/** M1-UX-FIRSTRUN-V2: the folders `begin` prepared before the gesture. */
export interface SetupFolders {
  /** The Send folder for the first policy, checked or created (owner-first-policy.ts). */
  readonly send: SendFolderPlan;
  /** Inbox and Proofs folders this run created (removed again unless the policy applies). */
  readonly created: readonly string[];
}

/**
 * M1-UX-FIRSTRUN-V2: prepares the first-run folders under `home` before the gesture: Send by the
 * first-policy rules (prepareSendFolder: never through a link, a real empty folder, 0700), then,
 * only when Send is ready, `Inbox` and `Proofs` beside it (0700, created only when missing; an
 * existing entry, even a link, is left alone and never followed: core checks those folders itself
 * when it uses them). Never throws; never deletes anything it did not create.
 */
export async function prepareSetupFolders(home: string = homedir()): Promise<SetupFolders> {
  const send = await prepareSendFolder(home);
  const created: string[] = [];
  if (send.status !== 'ready') return Object.freeze({ send, created: Object.freeze(created) });
  const parent = dirname(send.folder);
  for (const name of OTHER_FOLDERS) {
    const folder = join(parent, name);
    try {
      await lstat(folder);
      continue;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') continue;
    }
    try {
      // Not recursive: the parent is the checked folder prepareSendFolder resolved.
      await mkdir(folder, { mode: 0o700 });
      created.push(folder);
    } catch {
      // Not fatal: core creates and checks the inbox and proofs folders when it uses them.
    }
  }
  return Object.freeze({ send, created: Object.freeze(created) });
}

/** M1-UX-FIRSTRUN-V2: removes what prepareSetupFolders created (only while empty). Never throws. */
export async function removeSetupFolders(folders: SetupFolders | undefined): Promise<void> {
  if (folders === undefined) return;
  for (const folder of [...folders.created].reverse()) {
    try {
      await rmdir(folder);
    } catch {
      // Not empty any more, or already gone: never remove anything else.
    }
  }
  await removeCreated(folders.send);
}

/** The fallback name of this computer for the backup-code save form (11 §5.5). */
export const UNNAMED_COMPUTER = 'this computer';

/**
 * M1-UX-FIRSTRUN-V2: the computer's name for the backup-code entry in the owner's password manager
 * ("AgentLink backup code – <computer name>", 08 §1): the host name without a `.local` suffix, when
 * it is 1..63 plain characters (letters, digits, space, `.`, `_`, `-`); otherwise "this computer".
 */
export function computerNameOf(hostname: string): string {
  const name = hostname.trim().replace(/\.local$/i, '');
  return /^[A-Za-z0-9 ._-]{1,63}$/.test(name) ? name : UNNAMED_COMPUTER;
}
