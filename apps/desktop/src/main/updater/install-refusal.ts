// UPD-4: every reason the Mac in-app install stops, as a fixed code. A refusal never carries a URL,
// a path or anything from the network; the person sees one fixed sentence and the existing download
// link (release-check.ts, the DMG link built from the version), whatever the code.
import { UpdateRefusal } from './manifest.js';
import type { FailedReason } from './state.js';

export type InstallRefusalCode =
  // before anything is downloaded
  | 'not_zip'
  | 'not_in_place'
  | 'not_writable'
  | 'other_volume'
  // download (same meaning as the manifest/download codes)
  | 'wrong_host'
  | 'oversize'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'download_failed'
  // unpacking and the unpacked tree
  | 'unpack_failed'
  | 'bad_archive'
  | 'path_escape'
  // the unpacked app
  | 'wrong_bundle_id'
  | 'wrong_version'
  | 'code_signature'
  | 'helper_identity'
  | 'node_signature'
  | 'bundle_hashes'
  | 'quarantined'
  // the swap (reported by the watchdog through the failed record, state.ts)
  | 'swap_failed'
  | 'not_permitted'
  | 'did_not_start'
  | 'did_not_quit'
  | 'rollback_incomplete';

const MESSAGES: Readonly<Record<InstallRefusalCode, string>> = Object.freeze({
  not_zip: 'the update has no in-app package for this computer',
  not_in_place: 'this copy of the app is not in a place it can update',
  not_writable: 'the app folder cannot be changed by this user',
  other_volume: 'the app is on another disk than its data folder',
  wrong_host: 'the update points to a place this app does not download from',
  oversize: 'the update is too large',
  size_mismatch: 'the downloaded update has the wrong size',
  hash_mismatch: 'the downloaded update does not match its checksum',
  download_failed: 'the update could not be downloaded',
  unpack_failed: 'the update could not be unpacked',
  bad_archive: 'the update package is not in the expected form',
  path_escape: 'the update package points outside itself',
  wrong_bundle_id: 'the update is not this app',
  wrong_version: 'the update is not the expected version',
  code_signature: 'the update does not pass the code check',
  helper_identity: 'the update has an unexpected helper',
  node_signature: 'the update has an unexpected runtime',
  bundle_hashes: 'the update files do not match their record',
  quarantined: 'the update carries a download mark',
  swap_failed: 'the update could not be started',
  not_permitted: 'the system did not allow the app to be replaced',
  did_not_start: 'the new version did not start in time',
  did_not_quit: 'the app did not close for the update',
  rollback_incomplete: 'the previous version could not be fully restored',
});

export class InstallRefusal extends Error {
  readonly code: InstallRefusalCode;
  constructor(code: InstallRefusalCode) {
    super(`update not installed: ${MESSAGES[code]}`);
    this.name = 'InstallRefusal';
    this.code = code;
  }
}

/** What the person sees for any refusal (11 §5): plain words, then the download link. */
export const INSTALL_COPY = Object.freeze({
  failed: "Couldn't update here. Download the new version instead.",
});

/** The watchdog's recorded reason → its fixed code (a record without a reason: did_not_start). */
export function failedReasonCode(reason: FailedReason | null): InstallRefusalCode {
  switch (reason) {
    case 'not_permitted':
      return 'not_permitted';
    case 'not_quit':
      return 'did_not_quit';
    case 'swap_failed':
      return 'swap_failed';
    case 'rollback_incomplete':
      return 'rollback_incomplete';
    default:
      return 'did_not_start';
  }
}

const DOWNLOAD_CODES = new Set<string>([
  'wrong_host',
  'oversize',
  'size_mismatch',
  'hash_mismatch',
  'download_failed',
]);

/** Any error → a fixed code (unknown errors are `download_failed` or `swap_failed`, never text). */
export function installCode(
  error: unknown,
  fallback: InstallRefusalCode = 'download_failed',
): InstallRefusalCode {
  if (error instanceof InstallRefusal) return error.code;
  if (error instanceof UpdateRefusal && DOWNLOAD_CODES.has(error.code))
    return error.code as InstallRefusalCode;
  return fallback;
}
