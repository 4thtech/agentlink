// What the files flows need from the runtime (M1-7f). The core does no file-system or network I/O
// of its own (it runs in Node, Workers and browsers alike), so the platform (@4thtech-io/node with
// M1-9d) supplies:
// - the realpath of each allowed folder, and each outgoing file already opened through its
//   allowed-folder check (openAllowedFile, M1-15); the core checks the realpath again (04 §4);
// - own storage, when configured, and the SSRF-safe fetch for the drop (the core builds the drop
//   adapter itself and signs with the KeyStore's drop key, M1-1g-e);
// - the SSRF-safe download of a payload URL (safeFetch, M1-15): https only, public addresses only,
//   redirects capped and re-checked, the byte cap applied;
// - the inbox folder, resolved and checked (exists, not hidden, outside the protected roots), with
//   file operations on names directly inside it: exclusive create without following a link (mode
//   0600), rename that never overwrites (TempFileOps, D-84).
// URLs and names given to the platform are secrets or untrusted content: the platform never logs
// them (I-5, I-7).
import type { CiphertextSource, FetchLike, StorageAdapter, TempFileOps } from '@4thtech-io/storage';
import type { PathFlavor } from '../path-guard.js';

/** One file to send. */
export interface OutgoingFile {
  /** The file's realpath, as the platform resolved and opened it. Never sent to anyone. */
  readonly realpath: string;
  /** The name the contact sees. Default: the last segment of `realpath`. */
  readonly name?: string;
  /** Default `application/octet-stream`. */
  readonly mime?: string;
  /** Plaintext bytes; a file that reads to another length is refused (`file_changed`). */
  readonly size: number;
  /** The bytes, read once, only after every check passed. */
  open(): Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

/**
 * A fixed code a platform's file operation may carry as `saveError` on the error it throws
 * (W4-AUTO-SAVE, 04 §4.1): the write failed for lack of space. Never a path or a name.
 */
export type InboxSaveError = 'disk_full';

/**
 * The OS "downloaded from the internet" mark on a saved file (D-142, 04 §4.1): set and read back
 * (`marked`); the OS has no common mark (`unsupported`: Linux, an accepted residual); or setting or
 * reading it failed (`failed`: for example a FAT or exFAT volume or some network shares).
 */
export type QuarantineMark = 'marked' | 'unsupported' | 'failed';

/** The inbox folder (`files.inboxFolder`) as the platform resolved it. */
export interface InboxFolder {
  /** Its realpath (absolute). */
  readonly realpath: string;
  /** Operations on names directly inside it (see the header). */
  readonly ops: TempFileOps;
  /** W4-AUTO-SAVE: free bytes on the folder's volume (for the 1 GiB reserve, 04 §4.1). */
  freeBytes?(): Promise<number>;
  /**
   * W4-AUTO-SAVE: sets the quarantine mark on `name` (the hidden temporary file directly inside the
   * folder) and reads it back. The mark never carries a link, a host or a referrer (I-7).
   */
  mark?(name: string): Promise<QuarantineMark>;
  /** W4-AUTO-SAVE: true when `name` is a regular file directly inside the folder (no link followed). */
  isSavedFile?(name: string): Promise<boolean>;
  /** W4-AUTO-SAVE: releases the held folder handle; the core calls it once the save ended. */
  close?(): Promise<void>;
}

/** The drop's configuration (D-48). The core signs every request with the KeyStore's drop key. */
export interface DropConfig {
  /** `https://host[:port]`; default the 4thTech drop. */
  readonly endpoint?: string;
  /** The SSRF-safe fetch (M1-15). */
  readonly fetch: FetchLike;
  /** A smaller size cap for a staging or self-hosted drop. */
  readonly maxBytes?: number;
  /** The drop's quota per drop key in 7 days, for a staging or self-hosted drop (M1-11r-c). */
  readonly weeklyQuotaBytes?: number;
}

export interface FilesPlatform {
  /** The path flavour of this runtime. Default `posix`. */
  readonly flavor?: PathFlavor;
  /** The realpath of each of the policy's `files.allowedFolders` that exists. */
  allowedFolderRealpaths(folders: readonly string[]): Promise<readonly string[]>;
  /** Own storage (07 §5.1), when configured. */
  readonly ownStorage?: StorageAdapter;
  /** The encrypted drop; absent when this runtime cannot reach one. */
  readonly drop?: DropConfig;
  /** Downloads a payload `url` under the SSRF rules (04 §4), stopping at the cap it is given. */
  download(url: string): CiphertextSource;
  /**
   * Resolves `files.inboxFolder` (a policy path, `~` allowed) for one save, under the folder rules of
   * 04 §4.1; `allowedFolders` are the policy's send folders, which the Inbox folder must not equal,
   * be inside or contain.
   */
  inbox(folder: string, allowedFolders?: readonly string[]): Promise<InboxFolder>;
}
