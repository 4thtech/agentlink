// WP-R2 (D-147 (6), (7); 04 §2.3.3 "Kit record", "Check that my kit opens"): the server-side record of
// the last recovery kit saved on this computer, the status it gives the Backup & restore page, Show in
// Finder by the recorded path only, and the in-memory export handle for Check right after a save.
//
// - The record is `~/.agentlink/kit-record.json`, 0600, written through a temporary file and a rename;
//   it survives a restart (a fresh read finds it) and a broken, linked or unknown record is
//   `unreadable` (the page then falls back to its own flag), never trusted in part.
// - The status never carries the path; `missing` compares the record with today's IDs and contacts;
//   a record whose `backup.export` core does not hold reads as no kit.
// - Show in Finder reveals only a regular file at the recorded path (no link), never opens it.
// - An export handle is single use and lasts 10 minutes.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KIT_RECORD_FILE,
  kitStatus,
  markKitRecordChecked,
  readKitRecord,
  revealKitFile,
  writeKitRecord,
  type KitRecord,
} from './kit-record.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const KIT = 'K'.repeat(22);

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlink-kit-record-'));
  dir = join(root, '.agentlink');
  mkdirSync(dir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A signed `backup.export` as the record keeps it (the signature is not checked here; core does). */
const proof = (agent: string, nonce: string, kitId = KIT) => ({
  body: {
    v: 1,
    agent,
    owner: 'aa'.repeat(32),
    op: 'backup.export',
    params: { kitId, contents: 'full' },
    nonce,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_600,
  },
  sig: 'cd'.repeat(64),
});

function record(over: Partial<KitRecord> = {}): KitRecord {
  return {
    v: 1,
    kitId: KIT,
    at: 1_800_000_000,
    covers: [A, B],
    names: { [A]: 'default', [B]: 'work' },
    peopleAtSave: { [A]: 3, [B]: 1 },
    exports: {
      [A]: proof(A, 'n'.repeat(22), over.kitId ?? KIT),
      [B]: proof(B, 'm'.repeat(22), over.kitId ?? KIT),
    },
    contents: 'full',
    file: join(root, 'Downloads', 'agentlink-recovery-kit-2027-01-15.alkk'),
    // UX1113-QA2 N14: a kit counts as backed up once it opened with its code (Check).
    checked: true,
    ...over,
  };
}

/** A record as the save writes it: not checked yet. */
function unchecked(over: Partial<KitRecord> = {}): KitRecord {
  return Object.fromEntries(
    Object.entries(record(over)).filter(([key]) => key !== 'checked'),
  ) as unknown as KitRecord;
}

describe('kit record file (04 §2.3.3 "Kit record")', () => {
  it('writes 0600 through a temporary file and reads back after a restart', async () => {
    await writeKitRecord(dir, record());
    const path = join(dir, KIT_RECORD_FILE);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    // Only the record is left: no temporary file.
    expect(await readdir(dir)).toEqual([KIT_RECORD_FILE]);
    // A "restart": nothing is cached in memory; a fresh read finds the same record.
    expect(await readKitRecord(dir)).toEqual({ status: 'saved', record: record() });
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(raw['v']).toBe(1);
  });

  it('a newer save replaces the record', async () => {
    await writeKitRecord(dir, record());
    await writeKitRecord(dir, record({ kitId: 'L'.repeat(22), at: 1_800_000_100 }));
    const read = await readKitRecord(dir);
    expect(read.status === 'saved' && read.record.kitId).toBe('L'.repeat(22));
    expect(await readdir(dir)).toEqual([KIT_RECORD_FILE]);
  });

  it('no record is none', async () => {
    expect(await readKitRecord(dir)).toEqual({ status: 'none' });
    expect(await readKitRecord(join(root, 'missing'))).toEqual({ status: 'none' });
  });

  it('a damaged, unknown or oversized record is unreadable, never trusted in part', async () => {
    const path = join(dir, KIT_RECORD_FILE);
    const bad: unknown[] = [
      'not json',
      { ...record(), v: 2 },
      { ...record(), extra: true },
      { ...record(), kitId: 'short' },
      { ...record(), covers: [A, A] },
      { ...record(), covers: [] },
      { ...record(), names: { [A]: 'default' } },
      { ...record(), names: { [A]: 'Default', [B]: 'work' } },
      { ...record(), peopleAtSave: { [A]: -1, [B]: 1 } },
      { ...record(), exports: { [A]: 'x', [B]: proof(B, 'm'.repeat(22)) } },
      // WP-R2b (IR L-3): each proof is a signed backup.export of that ID naming this kitId.
      { ...record(), exports: { [A]: proof(A, 'x'), [B]: proof(B, 'm'.repeat(22)) } },
      { ...record(), exports: { [A]: proof(B, 'n'.repeat(22)), [B]: proof(B, 'm'.repeat(22)) } },
      {
        ...record(),
        exports: { [A]: proof(A, 'n'.repeat(22), 'Z'.repeat(22)), [B]: proof(B, 'm'.repeat(22)) },
      },
      {
        ...record(),
        exports: {
          [A]: { ...proof(A, 'n'.repeat(22)), sig: 'not hex' },
          [B]: proof(B, 'm'.repeat(22)),
        },
      },
      {
        ...record(),
        exports: {
          [A]: { ...proof(A, 'n'.repeat(22)), extra: 1 },
          [B]: proof(B, 'm'.repeat(22)),
        },
      },
      { ...record(), contents: 'everything' },
      { ...record(), file: 'relative/path.alkk' },
      { ...record(), at: 1.5 },
      {
        ...record(),
        covers: Array.from({ length: 17 }, (_, i) => `0x${String(i).padStart(40, '0')}`),
      },
    ];
    for (const value of bad) {
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), {
        mode: 0o600,
      });
      expect(await readKitRecord(dir)).toEqual({ status: 'unreadable' });
    }
    writeFileSync(path, ' '.repeat(70_000), { mode: 0o600 });
    expect(await readKitRecord(dir)).toEqual({ status: 'unreadable' });
  });

  it.skipIf(process.platform === 'win32')('a record that is a link is unreadable', async () => {
    const elsewhere = join(root, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(record()), { mode: 0o600 });
    symlinkSync(elsewhere, join(dir, KIT_RECORD_FILE));
    expect(await readKitRecord(dir)).toEqual({ status: 'unreadable' });
  });

  it('refuses to write a record that is not valid', async () => {
    await expect(writeKitRecord(dir, record({ covers: [] }))).rejects.toThrow();
    await expect(writeKitRecord(dir, record({ file: 'x.alkk' }))).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('kitStatus (GET /api/ui/backup body)', () => {
  const today = [
    { name: 'default', label: 'Personal', contacts: 3 },
    { name: 'work', label: 'Work', contacts: 1 },
  ];

  it('backed up: covers every ID, no one joined since; never the path', () => {
    const status = kitStatus({ status: 'saved', record: record() }, today, true);
    expect(status).toEqual({
      record: 'saved',
      state: 'backed_up',
      lastKit: {
        at: 1_800_000_000,
        covers: [
          { name: 'default', label: 'Personal' },
          { name: 'work', label: 'Work' },
        ],
        peopleAtSave: 4,
      },
      missing: { ids: [], people: 0 },
    });
    expect(JSON.stringify(status)).not.toContain('Downloads');
    expect(JSON.stringify(status)).not.toContain('.alkk');
    expect(JSON.stringify(status)).not.toContain(KIT);
  });

  it('out of date: an ID added since and people who joined since', () => {
    const status = kitStatus(
      { status: 'saved', record: record() },
      [
        { name: 'default', label: 'Personal', contacts: 5 },
        { name: 'work', label: 'Work', contacts: 0 },
        { name: 'shop', label: 'Shop', contacts: 2 },
      ],
      undefined,
    );
    expect(status.state).toBe('out_of_date');
    expect(status.missing).toEqual({ ids: [{ name: 'shop', label: 'Shop' }], people: 2 });
  });

  it('an ID now under a covered name but another agentId is missing', () => {
    const status = kitStatus(
      { status: 'saved', record: record() },
      [
        { name: 'default', label: 'Personal', contacts: 3, agentId: C },
        { name: 'work', label: 'Work', contacts: 1 },
      ],
      undefined,
    );
    expect(status.state).toBe('out_of_date');
    expect(status.missing?.ids).toEqual([{ name: 'default', label: 'Personal' }]);
  });

  it('IDs being removed are not missing; unknown contact counts add no one', () => {
    const status = kitStatus(
      { status: 'saved', record: record() },
      [
        { name: 'default', label: 'Personal', contacts: null },
        { name: 'work', label: 'Work', contacts: 1 },
        { name: 'old', label: 'Old', contacts: 4, removing: true },
      ],
      true,
    );
    expect(status.state).toBe('backed_up');
  });

  it('no record, a record core does not hold, and an unreadable record', () => {
    expect(kitStatus({ status: 'none' }, today, undefined)).toEqual({
      record: 'none',
      state: 'none',
      lastKit: null,
      missing: null,
    });
    expect(kitStatus({ status: 'saved', record: record() }, today, false)).toEqual({
      record: 'none',
      state: 'none',
      lastKit: null,
      missing: null,
    });
    expect(kitStatus({ status: 'unreadable' }, today, undefined)).toEqual({
      record: 'unreadable',
      state: 'unknown',
      lastKit: null,
      missing: null,
    });
  });
});

describe('UX1113-QA2 N14: a save that was never checked is not "backed up"', () => {
  const today = [
    { name: 'default', label: 'Personal', contacts: 3 },
    { name: 'work', label: 'Work', contacts: 1 },
  ];

  it('a save whose kit never opened with its code reads as unfinished, with its date and names', () => {
    const status = kitStatus({ status: 'saved', record: unchecked() }, today, true);
    expect(status.state).toBe('unfinished');
    expect(status.record).toBe('saved');
    expect(status.lastKit?.covers).toEqual([
      { name: 'default', label: 'Personal' },
      { name: 'work', label: 'Work' },
    ]);
    // Unfinished wins over out of date: whether the kit can be opened at all is unknown.
    const later = kitStatus(
      { status: 'saved', record: unchecked() },
      [...today, { name: 'shop', label: 'Shop', contacts: 0 }],
      undefined,
    );
    expect(later.state).toBe('unfinished');
  });

  it('the save writes an unchecked record; a check of that very kit marks it, once', async () => {
    await writeKitRecord(dir, unchecked());
    const raw = JSON.parse(await readFile(join(dir, KIT_RECORD_FILE), 'utf8')) as object;
    expect(raw).not.toHaveProperty('checked');
    // Another kit (another kitId) never marks this one.
    expect(await markKitRecordChecked(dir, 'L'.repeat(22))).toBe(false);
    let read = await readKitRecord(dir);
    expect(read.status === 'saved' && read.record.checked).toBeFalsy();
    expect(await markKitRecordChecked(dir, KIT)).toBe(true);
    read = await readKitRecord(dir);
    expect(read).toEqual({ status: 'saved', record: record() });
    expect(kitStatus(read, today, true).state).toBe('backed_up');
    expect(await readdir(dir)).toEqual([KIT_RECORD_FILE]);
  });

  it('no record, an unreadable record or a bad kitId: nothing is written', async () => {
    expect(await markKitRecordChecked(dir, KIT)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    writeFileSync(join(dir, KIT_RECORD_FILE), '{"v":1}');
    expect(await markKitRecordChecked(dir, KIT)).toBe(false);
    expect(await readFile(join(dir, KIT_RECORD_FILE), 'utf8')).toBe('{"v":1}');
    expect(await markKitRecordChecked(dir, 'not a kit id')).toBe(false);
  });

  it('a record with checked other than true is unreadable', async () => {
    const bad = { ...record(), checked: false };
    writeFileSync(join(dir, KIT_RECORD_FILE), JSON.stringify(bad));
    expect(await readKitRecord(dir)).toEqual({ status: 'unreadable' });
  });
});

describe('revealKitFile (Show in Finder by the recorded path only)', () => {
  function kitFile(): string {
    mkdirSync(join(root, 'Downloads'), { recursive: true });
    const file = join(root, 'Downloads', 'agentlink-recovery-kit-2027-01-15.alkk');
    writeFileSync(file, 'ALKK', { mode: 0o600 });
    return file;
  }

  it('reveals the recorded regular file in its folder', async () => {
    const file = kitFile();
    const seen: [string, string][] = [];
    const outcome = await revealKitFile(
      { status: 'saved', record: record({ file }) },
      dir,
      (f, d) => {
        seen.push([f, d]);
        return Promise.resolve(true);
      },
    );
    expect(outcome).toBe('shown');
    expect(seen).toEqual([[file, join(root, 'Downloads')]]);
  });

  it('no record or no file is not_found; the revealer is never called', async () => {
    const calls: string[] = [];
    const revealer = (f: string) => {
      calls.push(f);
      return Promise.resolve(true);
    };
    expect(await revealKitFile({ status: 'none' }, dir, revealer)).toBe('not_found');
    expect(await revealKitFile({ status: 'unreadable' }, dir, revealer)).toBe('not_found');
    expect(await revealKitFile({ status: 'saved', record: record() }, dir, revealer)).toBe(
      'not_found',
    );
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'a link, a folder, a FIFO-like non-file or a file under ~/.agentlink is refused',
    async () => {
      const real = kitFile();
      const linkFolder = join(root, 'Desktop');
      mkdirSync(linkFolder);
      const link = join(linkFolder, 'agentlink-recovery-kit-2027-01-16.alkk');
      symlinkSync(real, link);
      const folder = join(root, 'Desktop', 'agentlink-recovery-kit-2027-01-17.alkk');
      mkdirSync(folder);
      const inside = join(dir, 'agentlink-recovery-kit-2027-01-18.alkk');
      writeFileSync(inside, 'ALKK', { mode: 0o600 });
      const other = join(root, 'Downloads', 'notes.txt');
      writeFileSync(other, 'x');
      const calls: string[] = [];
      const revealer = (f: string) => {
        calls.push(f);
        return Promise.resolve(true);
      };
      for (const file of [link, folder, inside, other]) {
        expect(
          await revealKitFile({ status: 'saved', record: record({ file }) }, dir, revealer),
        ).toBe('refused');
      }
      expect(calls).toEqual([]);
    },
  );

  it('the OS revealer failing is not_opened', async () => {
    const file = kitFile();
    chmodSync(file, 0o600);
    expect(
      await revealKitFile({ status: 'saved', record: record({ file }) }, dir, () =>
        Promise.resolve(false),
      ),
    ).toBe('not_opened');
  });
});
