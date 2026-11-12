// REL051-CF3 (R1-CLASS-03, R1-CLASS-04; 04 §2.3.3 "Restore in the app" T-7, T-12; §2.5; D-147 (5);
// proposed, owner confirms at merge): the marker of a master code that was made but not yet saved.
//
// First run and a restore on a computer without an owner each make a new master code, which the page
// shows once. Until the owner says "I saved it" (or replaces it in Settings), this marker says so,
// so that a later start never sends the owner to a screen that asks for a code nobody was shown:
//
//   ~/.agentlink/master-code-unsaved.json   (0600, temporary file and rename, never followed)
//   {"v":1,"kind":"first_run"|"restore","stage":"writing"|"shown","ownerNostr":hex,"item"?:hex,
//    "pid":n,"at":ms}
//
// `writing`: written before the owner item, with `item` = SHA-256 of the `ALKO` blob the run is about
// to store (restore only); `shown`: the code is in the run's one answer. It holds no secret: no code,
// seed or ciphertext, only a public key, a hash of ciphertext, a process ID and a time. It is a hint,
// never an authority: a same-user process can write or delete it (G-1). The only thing it can cause
// is the restore engine's start-up roll-back (recovery-kit-restore.ts `settle`), which removes an
// owner item only while it is still exactly the bytes whose hash is here, no passkey item exists and
// the run that wrote it is gone; a process that can read that item can delete it directly anyway.
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeHex, encodeHex, randomBytes } from '@4thtech-io/crypto';

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
export const UNSAVED_FILE = 'master-code-unsaved.json';
const MAX_BYTES = 1024;

export type UnsavedKind = 'first_run' | 'restore';
export type UnsavedStage = 'writing' | 'shown';

export interface UnsavedMarker {
  readonly kind: UnsavedKind;
  readonly stage: UnsavedStage;
  /** The new owner's x-only Nostr key (public). */
  readonly ownerNostr: Uint8Array;
  /** Restore: SHA-256 of the `ALKO` blob this run wrote as the `owner` item. */
  readonly item?: Uint8Array;
  /** The process that wrote it. */
  readonly pid: number;
  /** When (ms since 1970). */
  readonly at: number;
}

const markerPath = (home: string): string => join(home, '.agentlink', UNSAVED_FILE);

/** Writes the marker (replacing an earlier one), 0600, through a new temporary file and a link. */
export async function writeUnsavedMarker(home: string, marker: UnsavedMarker): Promise<void> {
  const dir = join(home, '.agentlink');
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const text = `${JSON.stringify({
    v: 1,
    kind: marker.kind,
    stage: marker.stage,
    ownerNostr: encodeHex(marker.ownerNostr),
    ...(marker.item === undefined ? {} : { item: encodeHex(marker.item) }),
    pid: marker.pid,
    at: marker.at,
  })}\n`;
  const temp = join(dir, `.${UNSAVED_FILE}.${encodeHex(randomBytes(8))}.tmp`);
  const fh = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  const path = markerPath(home);
  await unlink(path).catch(() => undefined);
  try {
    await link(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** The marker, or undefined when there is none or it is not exactly a well-formed regular file. */
export async function readUnsavedMarker(home: string): Promise<UnsavedMarker | undefined> {
  const path = markerPath(home);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const fh = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    let text: string;
    try {
      text = await readFile(fh, 'utf8');
    } finally {
      await fh.close();
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { v, kind, stage, ownerNostr, item, pid, at } = parsed;
    if (v !== 1 || (kind !== 'first_run' && kind !== 'restore')) return undefined;
    if (stage !== 'writing' && stage !== 'shown') return undefined;
    if (typeof ownerNostr !== 'string' || typeof pid !== 'number' || typeof at !== 'number') {
      return undefined;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(at)) return undefined;
    if (item !== undefined && typeof item !== 'string') return undefined;
    return {
      kind,
      stage,
      ownerNostr: decodeHex(ownerNostr, { length: 32 }),
      ...(typeof item === 'string' ? { item: decodeHex(item, { length: 32 }) } : {}),
      pid,
      at,
    };
  } catch {
    return undefined;
  }
}

/** Removes the marker (nothing when there is none). */
export async function removeUnsavedMarker(home: string): Promise<void> {
  await unlink(markerPath(home)).catch(() => undefined);
}
