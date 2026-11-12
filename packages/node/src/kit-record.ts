// WP-R2 (D-147 (6), (7); 04 §2.3.3 "Kit record", "Check that my kit opens"; design-1112 §6.2 to
// §6.4): the record of the last recovery kit saved on this computer, the status the Backup & restore
// page shows from it and Show in Finder by the recorded path. (WP-R2b: Check's export handle is the
// restore engine's, recovery-kit-restore.ts registerExportedKit.)
//
// The record is `~/.agentlink/kit-record.json` (mode 0600, written through a temporary file and a
// rename):
//   {"v":1,"kitId","at","covers":[agentId…],"names":{agentId:name},"peopleAtSave":{agentId:n},
//    "exports":{agentId:{body,sig}},"contents","file","checked"?:true}
// `names` (each covered ID's folder name, the kit manifest's) lets the page match today's IDs, and
// `exports` (each covered ID's signed `backup.export`, public: no secret in it) lets core say this
// very save was applied (core `backupExportRecorded` matches the nonce row's action hash, so the
// kitId is bound too, WP-R2b IR L-3); both are additions to the 04 §2.3.3 format, proposed, owner confirms
// at merge. `file` is the kit's absolute path, kept for Show in Finder only: it never leaves the
// server, and Check never opens a kit by it.
//
// UX1113-QA2 N14 (design-1112 §6.3: Done needs "Check that it opens"): the save writes the record
// without `checked`; it reads as `unfinished`, never "You're backed up", until this very kit (its
// kitId) opened with its code in Check (the checklist's step 3, or Check my kit later), which adds
// `checked: true`. A save the owner left before the code was checked therefore keeps asking for a
// kit. An addition to the 04 §2.3.3 format, proposed, owner confirms at merge.
//
// It holds no secret and nothing is logged from it. It is a display aid, not a security boundary: a
// same-user process can forge or delete it, which only changes a status card (G-1). A record that
// cannot be read in full (missing fields, unknown keys, a link, too large) is `unreadable`, never
// trusted in part; the page then keeps its own fallback flag.
import { constants } from 'node:fs';
import { open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import type { FileRevealer } from './approval-os.js';

export const KIT_RECORD_FILE = 'kit-record.json';

/** At most 16 IDs in one kit (04 §2.3.3 "In the local app", T-5). */
export const MAX_KIT_IDS = 16;
const MAX_RECORD_BYTES = 65_536;
const MAX_PATH_LENGTH = 4096;
const MAX_PEOPLE = 1_000_000;

const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const O_NONBLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const B64_16 = /^[A-Za-z0-9_-]{22}$/;
/** A BIP-340 signature, 64 bytes as lowercase hex. */
const SIG = /^[0-9a-f]{128}$/;
/** The kit file names the export writes (recovery-kit-export.ts). */
const KIT_FILE_NAME = /^agentlink-recovery-kit-\d{4}-\d{2}-\d{2}(?:-\d{1,2})?\.alkk$/;

/** One covered ID's signed `backup.export` as core applied it (public; no secret). */
export interface KitExportProof {
  readonly body: Readonly<Record<string, unknown>>;
  readonly sig: string;
}

/** The proof exactly as written for `agentId` and `kitId`, deep-copied, or undefined. */
function parseProof(value: unknown, agentId: string, kitId: string): KitExportProof | undefined {
  if (!isObject(value) || !sameKeys(value, ['body', 'sig'])) return undefined;
  const { body, sig } = value;
  if (typeof sig !== 'string' || !SIG.test(sig) || !isObject(body)) return undefined;
  const params = body['params'];
  if (
    body['op'] !== 'backup.export' ||
    body['agent'] !== agentId ||
    typeof body['nonce'] !== 'string' ||
    !B64_16.test(body['nonce']) ||
    !isObject(params) ||
    params['kitId'] !== kitId
  ) {
    return undefined;
  }
  return Object.freeze({
    body: Object.freeze(JSON.parse(JSON.stringify(body)) as Record<string, unknown>),
    sig,
  });
}

export interface KitRecord {
  readonly v: 1;
  /** The kit's 16-byte ID, base64url. */
  readonly kitId: string;
  /** Unix seconds of the save. */
  readonly at: number;
  /** The covered IDs, in kit order. */
  readonly covers: readonly string[];
  /** Each covered ID's folder name (the kit manifest's `name`). */
  readonly names: Readonly<Record<string, string>>;
  /** Each covered ID's active contacts in its snapshot. */
  readonly peopleAtSave: Readonly<Record<string, number>>;
  /** Each covered ID's signed `backup.export` (its audit row in that ID's store is its hash). */
  readonly exports: Readonly<Record<string, KitExportProof>>;
  readonly contents: 'full' | 'identity';
  /** The kit's absolute path: for Show in Finder only, never answered to the page. */
  readonly file: string;
  /** UX1113-QA2 N14: this kit opened with its code (Check); absent until then. */
  readonly checked?: true;
}

export type KitRecordRead =
  | { readonly status: 'saved'; readonly record: KitRecord }
  | { readonly status: 'none' }
  | { readonly status: 'unreadable' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
};

const RECORD_KEYS = [
  'v',
  'kitId',
  'at',
  'covers',
  'names',
  'peopleAtSave',
  'exports',
  'contents',
  'file',
] as const;

/** The record exactly as written, or undefined (nothing of it is trusted in part). */
function parseRecord(value: unknown): KitRecord | undefined {
  if (!isObject(value)) return undefined;
  const hasChecked = Object.hasOwn(value, 'checked');
  if (!sameKeys(value, hasChecked ? [...RECORD_KEYS, 'checked'] : RECORD_KEYS)) return undefined;
  if (hasChecked && value['checked'] !== true) return undefined;
  const { v, kitId, at, covers, names, peopleAtSave, exports, contents, file } = value;
  if (v !== 1) return undefined;
  if (typeof kitId !== 'string' || !B64_16.test(kitId)) return undefined;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return undefined;
  if (!Array.isArray(covers) || covers.length === 0 || covers.length > MAX_KIT_IDS) {
    return undefined;
  }
  const ids: string[] = [];
  for (const id of covers as unknown[]) {
    if (typeof id !== 'string' || !AGENT_ID.test(id) || ids.includes(id)) return undefined;
    ids.push(id);
  }
  if (!isObject(names) || !sameKeys(names, ids)) return undefined;
  if (!isObject(peopleAtSave) || !sameKeys(peopleAtSave, ids)) return undefined;
  if (!isObject(exports) || !sameKeys(exports, ids)) return undefined;
  const proofs: Record<string, KitExportProof> = {};
  const seenNames = new Set<string>();
  for (const id of ids) {
    const name = names[id];
    if (typeof name !== 'string' || !AGENT_NAME.test(name) || seenNames.has(name)) return undefined;
    seenNames.add(name);
    const people = peopleAtSave[id];
    if (
      typeof people !== 'number' ||
      !Number.isSafeInteger(people) ||
      people < 0 ||
      people > MAX_PEOPLE
    ) {
      return undefined;
    }
    const proof = parseProof(exports[id], id, kitId);
    if (proof === undefined) return undefined;
    proofs[id] = proof;
  }
  if (contents !== 'full' && contents !== 'identity') return undefined;
  if (
    typeof file !== 'string' ||
    file.length > MAX_PATH_LENGTH ||
    file.includes('\0') ||
    !isAbsolute(file) ||
    !KIT_FILE_NAME.test(basename(file))
  ) {
    return undefined;
  }
  const pick = <T>(map: Record<string, unknown>): Readonly<Record<string, T>> =>
    Object.freeze(Object.fromEntries(ids.map((id) => [id, map[id] as T])));
  return Object.freeze({
    v: 1,
    kitId,
    at,
    covers: Object.freeze(ids),
    names: pick<string>(names),
    peopleAtSave: pick<number>(peopleAtSave),
    exports: pick<KitExportProof>(proofs),
    contents,
    file,
    ...(hasChecked ? { checked: true as const } : {}),
  });
}

/** Reads the record without following a link; never throws. */
export async function readKitRecord(agentlinkDir: string): Promise<KitRecordRead> {
  let handle: FileHandle;
  try {
    handle = await open(
      join(agentlinkDir, KIT_RECORD_FILE),
      constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'none' } : { status: 'unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return { status: 'unreadable' };
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) return { status: 'unreadable' };
    const record = parseRecord(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    return record === undefined ? { status: 'unreadable' } : { status: 'saved', record };
  } catch {
    return { status: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Writes the record (0600) through a new temporary file beside it and a rename, so a reader sees the
 * old record or the new one, never part of one. Throws for a record that is not valid (nothing is
 * written) or when the folder cannot be written; the error carries no path.
 */
export async function writeKitRecord(agentlinkDir: string, record: KitRecord): Promise<void> {
  const checked = parseRecord(JSON.parse(JSON.stringify(record)) as unknown);
  if (checked === undefined) throw new Error('kit record: not valid');
  const text = `${JSON.stringify({
    v: checked.v,
    kitId: checked.kitId,
    at: checked.at,
    covers: checked.covers,
    names: checked.names,
    peopleAtSave: checked.peopleAtSave,
    exports: checked.exports,
    contents: checked.contents,
    file: checked.file,
    ...(checked.checked === true ? { checked: true } : {}),
  })}\n`;
  const temp = join(agentlinkDir, `.${KIT_RECORD_FILE}.${encodeBase64url(randomBytes(12))}.tmp`);
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // rename replaces the name itself: a link at the record's name is replaced, never followed.
    await rename(temp, join(agentlinkDir, KIT_RECORD_FILE));
    renamed = true;
  } catch {
    throw new Error('kit record: not written');
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

/**
 * UX1113-QA2 N14: marks the record checked when its kit is `kitId` (a kit that just opened with its
 * code in Check). True when the record now says checked; false (nothing written) for no record, an
 * unreadable one or another kit. Never throws: a display aid (G-1).
 */
export async function markKitRecordChecked(agentlinkDir: string, kitId: string): Promise<boolean> {
  if (typeof kitId !== 'string' || !B64_16.test(kitId)) return false;
  const read = await readKitRecord(agentlinkDir);
  if (read.status !== 'saved' || read.record.kitId !== kitId) return false;
  if (read.record.checked === true) return true;
  try {
    await writeKitRecord(agentlinkDir, { ...read.record, checked: true });
    return true;
  } catch {
    return false;
  }
}

/** One of today's IDs, as the Agents list knows it (never a path). */
export interface KitTodayId {
  /** The folder name. */
  readonly name: string;
  /** Plain display text: the verified label, else the name. */
  readonly label: string;
  /** Active contacts; null when the store cannot be read just now. */
  readonly contacts: number | null;
  /** The ID's agentId when known (the open ID); a different one under a covered name is not covered. */
  readonly agentId?: string;
  /** Removal not finished: not counted as missing. */
  readonly removing?: boolean;
}

export interface KitIdView {
  readonly name: string;
  readonly label: string;
}

/**
 * The body of `GET /api/ui/backup` beyond `export` (frozen for WP-R4):
 * - `record`: `saved` (a record names an applied save), `none` (no save, or a record core does not
 *   hold) or `unreadable` (the page then keeps its own fallback flag);
 * - `state`: `backed_up`, `out_of_date`, `unfinished` (UX1113-QA2 N14: saved, but the kit never
 *   opened with its code), `none` or `unknown` (record unreadable);
 * - `lastKit`: `{at, covers, peopleAtSave}` (unix seconds, the covered IDs by name and label, the
 *   people in the kit in all) or null;
 * - `missing`: `{ids, people}` (today's IDs not in the kit, and people who joined a covered ID since)
 *   or null. Never a path, a kitId or a nonce.
 */
export interface KitStatus {
  readonly record: 'saved' | 'none' | 'unreadable';
  readonly state: 'backed_up' | 'out_of_date' | 'unfinished' | 'none' | 'unknown';
  readonly lastKit: {
    readonly at: number;
    readonly covers: readonly KitIdView[];
    readonly peopleAtSave: number;
  } | null;
  readonly missing: { readonly ids: readonly KitIdView[]; readonly people: number } | null;
}

const NO_KIT: KitStatus = Object.freeze({
  record: 'none',
  state: 'none',
  lastKit: null,
  missing: null,
});
const UNKNOWN: KitStatus = Object.freeze({
  record: 'unreadable',
  state: 'unknown',
  lastKit: null,
  missing: null,
});

/**
 * The page's status from the record and today's IDs. `verified` is core's answer for the covered
 * IDs it could check (false: a covered ID's store holds no such `backup.export`, so no kit).
 */
export function kitStatus(
  read: KitRecordRead,
  today: readonly KitTodayId[],
  verified: boolean | undefined,
): KitStatus {
  if (read.status === 'unreadable') return UNKNOWN;
  if (read.status === 'none' || verified === false) return NO_KIT;
  const { record } = read;
  const byName = new Map(today.map((id) => [id.name, id]));
  const covered = new Set<string>();
  let people = 0;
  const covers = record.covers.map((agentId): KitIdView => {
    const name = record.names[agentId] as string;
    const now = byName.get(name);
    if (now !== undefined && (now.agentId === undefined || now.agentId === agentId)) {
      covered.add(name);
      const before = record.peopleAtSave[agentId] ?? 0;
      if (now.contacts !== null && now.contacts > before) people += now.contacts - before;
    }
    return Object.freeze({ name, label: now?.label ?? name });
  });
  const missingIds = today
    .filter((id) => id.removing !== true && !covered.has(id.name))
    .map((id) => Object.freeze({ name: id.name, label: id.label }));
  const peopleAtSave = record.covers.reduce((n, id) => n + (record.peopleAtSave[id] ?? 0), 0);
  return Object.freeze({
    record: 'saved',
    // N14: whether this kit opens at all is unknown until it was checked; that comes first.
    state:
      record.checked !== true
        ? 'unfinished'
        : missingIds.length > 0 || people > 0
          ? 'out_of_date'
          : 'backed_up',
    lastKit: Object.freeze({ at: record.at, covers: Object.freeze(covers), peopleAtSave }),
    missing: Object.freeze({ ids: Object.freeze(missingIds), people }),
  });
}

/** How Show in Finder for the kit ended. */
export type KitRevealOutcome = 'shown' | 'not_found' | 'refused' | 'not_opened';

/** True when `path` is `folder` or inside it, by real path. */
async function inside(path: string, folder: string): Promise<boolean> {
  const real = await realpath(folder).catch(() => resolve(folder));
  return path === real || path.startsWith(`${real}${sep}`);
}

/**
 * Show in Finder for the recorded kit (04 §2.3.3 "Kit record", §4 realpath rules): only the record's
 * own `file`, only a regular file (opened once without following a link, then re-checked by real
 * path, device and inode), never under `~/.agentlink`; the OS revealer selects it in its folder by a
 * fixed program with no shell. Nothing is opened, launched or read. Fixed outcomes only.
 */
export async function revealKitFile(
  read: KitRecordRead,
  agentlinkDir: string,
  revealer: FileRevealer,
): Promise<KitRevealOutcome> {
  if (read.status !== 'saved') return 'not_found';
  const target = read.record.file;
  if (!isAbsolute(target) || !KIT_FILE_NAME.test(basename(target))) return 'refused';
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? 'not_found'
      : 'refused';
  }
  let checked = false;
  try {
    const opened = await handle.stat();
    if (opened.isFile()) {
      // The final name is no link (O_NOFOLLOW above, and its real path is its real folder's entry);
      // folders above it may be (macOS /var), as the export recorded the home path it was given.
      const real = await realpath(target);
      const expected = join(await realpath(dirname(target)), basename(target));
      const current = await stat(target);
      checked =
        real === expected &&
        current.isFile() &&
        current.dev === opened.dev &&
        current.ino === opened.ino &&
        !(await inside(real, agentlinkDir));
    }
  } catch {
    checked = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!checked) return 'refused';
  try {
    return (await revealer(target, dirname(target))) ? 'shown' : 'not_opened';
  } catch {
    return 'not_opened';
  }
}

/**
 * WP-R2: what `GET /api/ui/backup` and Show in Finder need from the app host (built by the server,
 * approval-server.ts backupDeskOf, as the context's `backup`). Reads only; it signs nothing.
 */
export interface LocalUiBackupDesk {
  /** `~/.agentlink`, where the record lives. */
  readonly agentlinkDir: string;
  /** Today's IDs of this owner (the Agents list): names, labels, active contacts. */
  ids(): Promise<readonly KitTodayId[]>;
  /**
   * Core's `backupExportRecorded(signed, kitId)` for `agentId` when that ID's core is open here;
   * undefined when it cannot be checked now (another ID's core is never opened for a read).
   */
  exportRecorded(
    agentId: string,
    signed: KitExportProof,
    kitId: string,
  ): Promise<boolean | undefined>;
  /** The OS revealer (approval-os.ts osFileRevealer). */
  readonly revealer: FileRevealer;
}
