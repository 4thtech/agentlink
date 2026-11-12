// WP-D10 (plan 2026-11-12 Decision 5, Fable H3; 08 §8 "Signed updates"): the update document, parsed
// strictly (D-128) and verified against the pinned offline root key. Two document kinds share one URL:
//
//   key statement  {domain: "agentlink-desktop-root/v1", sequence, action, updateKey, issued, sig}
//                  signed by the ROOT key. `introduce` and `rotate` make `updateKey` the update key;
//                  `revoke` withdraws it. Only a statement with a higher sequence changes the state.
//   manifest       {domain: "agentlink-desktop-update/v1", channel, version, minimumVersion, released,
//                  expires, updateKey, statement, assets[{platform, arch, url, sha256, size}], sig}
//                  signed by the UPDATE key that `statement` (embedded and signed) names.
//
// Signatures are BIP-340 (through @4thtech-io/crypto only) over
// taggedHash(domain, JCS(the object without `sig`)), so neither kind can be replayed as the other or
// as any other AgentLink signature. Every refusal is an UpdateRefusal with a fixed code and a fixed
// message that never contains inbound text (I-5, I-7). Nothing here touches the network or the disk.
import {
  bip340Verify,
  canonicalizeToBytes,
  decodeHex,
  decodeUtf8,
  isBip340PublicKey,
  parseReceivedJson,
  TAGS,
  taggedHash,
} from '@4thtech-io/crypto';

export const STATEMENT_DOMAIN = TAGS.desktopKeyStatement;
export const MANIFEST_DOMAIN = TAGS.desktopUpdateManifest;
/** Size cap of an update document, checked before parsing. */
export const MAX_DOCUMENT_BYTES = 65536;
/** Largest installer we accept (1 GiB); the real ones are about 120 MB. */
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
export const MAX_ASSETS = 8;
/** A manifest is valid for at most this long after `released` (Decision 5: about 30 days). */
export const MAX_VALIDITY_MS = 31 * 24 * 60 * 60 * 1000;
/** Clock skew allowed for `released` and `issued` in the future. */
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
export const MAX_SEQUENCE = 2 ** 31 - 1;

/** The repository whose GitHub Releases carry the installers (host allowlist, Decision 5). */
export const RELEASES_PATH_PREFIX = '/4thtech/agentlink/releases/';
const RELEASES_DOWNLOAD_ORIGIN = 'https://github.com';

export type Channel = 'stable' | 'beta';
export type Platform = 'darwin' | 'win32';
export type Arch = 'arm64' | 'x64';
export type StatementAction = 'introduce' | 'rotate' | 'revoke';

export interface RootStatement {
  readonly domain: typeof STATEMENT_DOMAIN;
  readonly sequence: number;
  readonly action: StatementAction;
  readonly updateKey: string;
  readonly issued: string;
  readonly sig: string;
}

export interface UpdateAsset {
  readonly platform: Platform;
  readonly arch: Arch;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface UpdateManifest {
  readonly domain: typeof MANIFEST_DOMAIN;
  readonly channel: Channel;
  readonly version: string;
  readonly minimumVersion: string;
  readonly released: string;
  readonly expires: string;
  readonly updateKey: string;
  readonly statement: RootStatement;
  readonly assets: readonly UpdateAsset[];
  readonly sig: string;
}

export type UpdateDocument =
  | { readonly kind: 'statement'; readonly statement: RootStatement }
  | { readonly kind: 'manifest'; readonly manifest: UpdateManifest };

/** What the app has accepted from the root so far (persisted by state.ts). */
export interface KeyState {
  readonly sequence: number;
  readonly updateKey: string | null;
  readonly statement: RootStatement | null;
}

export type RefusalCode =
  | 'root_not_pinned'
  | 'oversize'
  | 'malformed'
  | 'unknown_field'
  | 'unsigned'
  | 'bad_signature'
  | 'wrong_key'
  | 'unrotated_key'
  | 'revoked'
  | 'wrong_channel'
  | 'not_yet_valid'
  | 'expired'
  | 'not_newer'
  | 'no_asset_for_this_computer'
  | 'wrong_host'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'download_failed';

const MESSAGES: Readonly<Record<RefusalCode, string>> = Object.freeze({
  root_not_pinned: 'updates are not set up in this build (no pinned root key)',
  oversize: 'the update document is too large',
  malformed: 'the update document is not in the expected form',
  unknown_field: 'the update document has a field this app does not know',
  unsigned: 'the update document is not signed',
  bad_signature: 'the update document signature does not verify',
  wrong_key: 'the update document is signed by a key this app does not trust',
  unrotated_key: 'the key statement is older than the one this app already has',
  revoked: 'the update key was withdrawn',
  wrong_channel: 'the update is for another channel',
  not_yet_valid: 'the update document is dated in the future',
  expired: 'the update document has expired',
  not_newer: 'the update is not newer than this version',
  no_asset_for_this_computer: 'the update has no installer for this computer',
  wrong_host: 'the update points to a place this app does not download from',
  size_mismatch: 'the downloaded installer has the wrong size',
  hash_mismatch: 'the downloaded installer does not match its checksum',
  download_failed: 'the update could not be downloaded',
});

export class UpdateRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode) {
    super(`update refused: ${MESSAGES[code]}`);
    this.name = 'UpdateRefusal';
    this.code = code;
  }
}

const refuse = (code: RefusalCode): never => {
  throw new UpdateRefusal(code);
};

// --- field rules ---------------------------------------------------------------------------------

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const NUM = '(0|[1-9][0-9]{0,5})';
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-beta\\.${NUM})?$`);
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INSTALLER_SUFFIX: Readonly<Record<Platform, string>> = Object.freeze({
  darwin: '.dmg',
  win32: '.exe',
});

type Obj = Readonly<Record<string, unknown>>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Exact key set: a missing `sig` is `unsigned`, another missing key `malformed`, an extra one `unknown_field`. */
function exactKeys(value: unknown, keys: readonly string[]): Obj {
  if (!isObject(value)) return refuse('malformed');
  const present = Object.keys(value);
  for (const k of present) if (!keys.includes(k)) refuse('unknown_field');
  if (keys.includes('sig') && !present.includes('sig')) refuse('unsigned');
  for (const k of keys) if (!present.includes(k)) refuse('malformed');
  return value;
}

const str = (v: unknown, re: RegExp): string =>
  typeof v === 'string' && re.test(v) ? v : refuse('malformed');

const int = (v: unknown, min: number, max: number): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : refuse('malformed');

/** RFC 3339 UTC to the second, and a real calendar time (round trip). Returns epoch ms. */
export function parseTimestamp(v: unknown): number {
  const text = str(v, TIMESTAMP);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== text) {
    return refuse('malformed');
  }
  return ms;
}

const publicKey = (v: unknown): string => {
  const hex = str(v, HEX32);
  return isBip340PublicKey(decodeHex(hex)) ? hex : refuse('malformed');
};

/** Parsed `MAJOR.MINOR.PATCH` with an optional `-beta.N`; a release sorts after its betas. */
export function parseVersion(v: unknown): readonly [number, number, number, number] {
  const m = VERSION.exec(typeof v === 'string' ? v : '');
  if (m === null) return refuse('malformed');
  const beta = m[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), beta];
}

/** -1, 0 or 1. Both arguments must be versions in the manifest form. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 4; i += 1) {
    if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  }
  return 0;
}

/**
 * The host allowlist for a URL the app fetches: https, no credentials, no port, and either this
 * repository's GitHub Releases path on github.com or GitHub's release download hosts (redirects).
 */
export function allowedDownloadUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return undefined;
  }
  if (url.hostname === 'github.com') {
    return url.pathname.startsWith(RELEASES_PATH_PREFIX) ? url : undefined;
  }
  return url.hostname === 'objects.githubusercontent.com' ||
    url.hostname === 'release-assets.githubusercontent.com'
    ? url
    : undefined;
}

/** The only asset URL form: https://github.com/4thtech/agentlink/releases/download/v<version>/<name>. */
function assetUrl(v: unknown, version: string, platform: Platform): string {
  if (typeof v !== 'string') return refuse('malformed');
  const prefix = `${RELEASES_DOWNLOAD_ORIGIN}${RELEASES_PATH_PREFIX}download/v${version}/`;
  if (!v.startsWith(prefix)) return refuse('wrong_host');
  const name = v.slice(prefix.length);
  if (!ASSET_NAME.test(name) || name.includes('..') || !name.endsWith(INSTALLER_SUFFIX[platform])) {
    return refuse('malformed');
  }
  const url = allowedDownloadUrl(v);
  if (url === undefined || url.href !== v) return refuse('wrong_host');
  return v;
}

// --- documents -----------------------------------------------------------------------------------

const STATEMENT_KEYS = ['domain', 'sequence', 'action', 'updateKey', 'issued', 'sig'] as const;
const MANIFEST_KEYS = [
  'domain',
  'channel',
  'version',
  'minimumVersion',
  'released',
  'expires',
  'updateKey',
  'statement',
  'assets',
  'sig',
] as const;
const ASSET_KEYS = ['platform', 'arch', 'url', 'sha256', 'size'] as const;

function parseStatement(value: unknown): RootStatement {
  const o = exactKeys(value, STATEMENT_KEYS);
  if (o['domain'] !== STATEMENT_DOMAIN) refuse('malformed');
  const action = o['action'];
  if (action !== 'introduce' && action !== 'rotate' && action !== 'revoke') refuse('malformed');
  parseTimestamp(o['issued']);
  return Object.freeze({
    domain: STATEMENT_DOMAIN,
    sequence: int(o['sequence'], 1, MAX_SEQUENCE),
    action: action as StatementAction,
    updateKey: publicKey(o['updateKey']),
    issued: o['issued'] as string,
    sig: str(o['sig'], HEX64),
  });
}

function parseAsset(value: unknown, version: string): UpdateAsset {
  const o = exactKeys(value, ASSET_KEYS);
  const platform = o['platform'];
  const arch = o['arch'];
  if (platform !== 'darwin' && platform !== 'win32') return refuse('malformed');
  if (arch !== 'arm64' && arch !== 'x64') return refuse('malformed');
  return Object.freeze({
    platform,
    arch,
    url: assetUrl(o['url'], version, platform),
    sha256: str(o['sha256'], HEX32),
    size: int(o['size'], 1, MAX_ASSET_BYTES),
  });
}

function parseManifest(value: unknown): UpdateManifest {
  const o = exactKeys(value, MANIFEST_KEYS);
  if (o['domain'] !== MANIFEST_DOMAIN) refuse('malformed');
  const channel = o['channel'];
  if (channel !== 'stable' && channel !== 'beta') return refuse('malformed');
  const version = o['version'] as string;
  parseVersion(version);
  parseVersion(o['minimumVersion']);
  if (compareVersions(o['minimumVersion'] as string, version) > 0) refuse('malformed');
  if (channel === 'stable' && version.includes('-')) refuse('malformed');
  const released = parseTimestamp(o['released']);
  const expires = parseTimestamp(o['expires']);
  if (expires <= released || expires - released > MAX_VALIDITY_MS) refuse('malformed');
  const list = o['assets'];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ASSETS) refuse('malformed');
  const assets = (list as unknown[]).map((a) => parseAsset(a, version));
  const pairs = new Set(assets.map((a) => `${a.platform}/${a.arch}`));
  if (pairs.size !== assets.length) refuse('malformed');
  return Object.freeze({
    domain: MANIFEST_DOMAIN,
    channel,
    version,
    minimumVersion: o['minimumVersion'] as string,
    released: o['released'] as string,
    expires: o['expires'] as string,
    updateKey: publicKey(o['updateKey']),
    statement: parseStatement(o['statement']),
    assets: Object.freeze(assets),
    sig: str(o['sig'], HEX64),
  });
}

/**
 * Parses the bytes received, strictly: the size cap first, then fatal UTF-8, then the D-128 received
 * text parse (duplicate names, escaped names and non-integer numbers refused at any depth), then the
 * exact schema of the kind its `domain` names. No signature is checked here.
 */
export function parseUpdateDocument(bytes: Uint8Array): UpdateDocument {
  if (!(bytes instanceof Uint8Array)) return refuse('malformed');
  if (bytes.length > MAX_DOCUMENT_BYTES) return refuse('oversize');
  let value: unknown;
  try {
    value = parseReceivedJson(decodeUtf8(bytes));
  } catch {
    return refuse('malformed');
  }
  if (!isObject(value)) return refuse('malformed');
  if (value['domain'] === STATEMENT_DOMAIN) {
    return Object.freeze({ kind: 'statement', statement: parseStatement(value) });
  }
  if (value['domain'] === MANIFEST_DOMAIN) {
    return Object.freeze({ kind: 'manifest', manifest: parseManifest(value) });
  }
  return refuse('malformed');
}

/** Re-parses a statement object (state.ts reads its own file with the same rules). */
export function parseStatementValue(value: unknown): RootStatement {
  return parseStatement(value);
}

// --- signatures ----------------------------------------------------------------------------------

function unsignedBody(value: object): Obj {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== 'sig') body[k] = v;
  return body;
}

/** The 32 bytes the root key signs for a statement. */
export function statementMessage(
  statement: Omit<RootStatement, 'sig'> | RootStatement,
): Uint8Array {
  return taggedHash(STATEMENT_DOMAIN, canonicalizeToBytes(unsignedBody(statement)));
}

/** The 32 bytes the update key signs for a manifest (the embedded statement keeps its `sig`). */
export function manifestMessage(
  manifest: Omit<UpdateManifest, 'sig'> | UpdateManifest,
): Uint8Array {
  return taggedHash(MANIFEST_DOMAIN, canonicalizeToBytes(unsignedBody(manifest)));
}

const verifies = (key: string, message: Uint8Array, sig: string): boolean =>
  bip340Verify(decodeHex(key), message, decodeHex(sig));

// --- trust ---------------------------------------------------------------------------------------

/** The pinned root, as root-key.json holds it; `undefined` while it is the placeholder. */
export interface PinnedRoot {
  readonly rootPublicKey: string;
  readonly minimumStatementSequence: number;
}

export function pinnedRoot(raw: unknown): PinnedRoot | undefined {
  if (!isObject(raw)) return undefined;
  const key = raw['rootPublicKey'];
  const floor = raw['minimumStatementSequence'];
  if (typeof key !== 'string' || !HEX32.test(key) || !isBip340PublicKey(decodeHex(key))) {
    return undefined;
  }
  if (
    typeof floor !== 'number' ||
    !Number.isSafeInteger(floor) ||
    floor < 0 ||
    floor > MAX_SEQUENCE
  ) {
    return undefined;
  }
  return Object.freeze({ rootPublicKey: key, minimumStatementSequence: floor });
}

/** Nothing accepted yet: the first valid statement at or above the pinned floor is taken. */
export const INITIAL_KEY_STATE: KeyState = Object.freeze({
  sequence: 0,
  updateKey: null,
  statement: null,
});

const sameStatement = (a: RootStatement, b: RootStatement): boolean =>
  a.sequence === b.sequence &&
  a.action === b.action &&
  a.updateKey === b.updateKey &&
  a.issued === b.issued &&
  a.sig === b.sig;

/**
 * Applies a root statement to the key state. The statement must verify under the pinned root key and
 * may never name the root key itself, nor sit below the pinned floor. A higher sequence replaces the state (`revoke` leaves no update
 * key); the same sequence must be the very statement already held; a lower one is `unrotated_key`.
 */
export function applyStatement(
  state: KeyState,
  statement: RootStatement,
  root: PinnedRoot,
  now: number,
): KeyState {
  if (statement.updateKey === root.rootPublicKey) refuse('wrong_key');
  if (!verifies(root.rootPublicKey, statementMessage(statement), statement.sig)) {
    refuse('bad_signature');
  }
  if (parseTimestamp(statement.issued) > now + MAX_FUTURE_SKEW_MS) refuse('not_yet_valid');
  // The pinned floor lets a later build refuse statements below a revocation even on a fresh state.
  if (statement.sequence < root.minimumStatementSequence) refuse('unrotated_key');
  if (statement.sequence < state.sequence) refuse('unrotated_key');
  if (statement.sequence === state.sequence) {
    if (state.statement === null || !sameStatement(state.statement, statement)) {
      refuse('unrotated_key');
    }
    return state;
  }
  return Object.freeze({
    sequence: statement.sequence,
    updateKey: statement.action === 'revoke' ? null : statement.updateKey,
    statement,
  });
}

export interface ManifestContext {
  readonly root: PinnedRoot;
  readonly state: KeyState;
  readonly currentVersion: string;
  readonly channel: Channel;
  readonly platform: string;
  readonly arch: string;
  readonly now: number;
}

export interface AcceptedUpdate {
  readonly state: KeyState;
  readonly version: string;
  /** The installed version is below the manifest's minimum: the update is required. */
  readonly required: boolean;
  readonly asset: UpdateAsset;
}

/**
 * Every acceptance rule of Decision 5, in order: the embedded root statement (signature, rotation),
 * the update key it names, the manifest signature under that key, channel, validity window, a
 * strictly greater version, and an installer for exactly this platform and arch.
 */
export function acceptManifest(manifest: UpdateManifest, ctx: ManifestContext): AcceptedUpdate {
  const state = applyStatement(ctx.state, manifest.statement, ctx.root, ctx.now);
  if (state.updateKey === null) refuse('revoked');
  if (manifest.updateKey !== state.updateKey) refuse('wrong_key');
  if (!verifies(manifest.updateKey, manifestMessage(manifest), manifest.sig)) {
    refuse('bad_signature');
  }
  if (manifest.channel !== ctx.channel) refuse('wrong_channel');
  if (parseTimestamp(manifest.released) > ctx.now + MAX_FUTURE_SKEW_MS) refuse('not_yet_valid');
  if (parseTimestamp(manifest.expires) <= ctx.now) refuse('expired');
  if (compareVersions(manifest.version, ctx.currentVersion) <= 0) refuse('not_newer');
  const asset = manifest.assets.find((a) => a.platform === ctx.platform && a.arch === ctx.arch);
  if (asset === undefined) return refuse('no_asset_for_this_computer');
  return Object.freeze({
    state,
    version: manifest.version,
    required: compareVersions(ctx.currentVersion, manifest.minimumVersion) < 0,
    asset,
  });
}
