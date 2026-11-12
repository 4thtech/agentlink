// WP-R2 (D-147 (6); 04 §2.3.3 "Kit record"; design-1112 §6.2): the Backup & restore page's status
// from the server's kit record, and Show in Finder by the recorded path.
//
// - `GET /api/ui/backup` answers `{export, record, state, lastKit, missing}` and never a path or the
//   kitId. `missing` compares the record with today's IDs and contacts. A record whose covered ID's
//   `backup.export` core does not hold reads as no kit. Without the backup desk (not wired, or not
//   the app host) the record is `unreadable` and the page keeps its own fallback flag.
// - The reveal handler takes no input and reveals only the recorded file (kit-record.ts checks it).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../context.js';
import { writeKitRecord, type LocalUiBackupDesk } from '../../kit-record.js';
import { BACKUP_REVEAL_PATH, backupRoutes, revealKit } from './backup.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;

let root: string;
let dir: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlink-backup-status-'));
  dir = join(root, '.agentlink');
  mkdirSync(dir);
  mkdirSync(join(root, 'Downloads'));
  file = join(root, 'Downloads', 'agentlink-recovery-kit-2027-01-15.alkk');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A signed `backup.export` as the record keeps it (core checks it, here a stand-in). */
const proof = (agent: string, nonce: string) => ({
  body: {
    v: 1,
    agent,
    owner: 'aa'.repeat(32),
    op: 'backup.export',
    params: { kitId: 'K'.repeat(22), contents: 'full' },
    nonce,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_600,
  },
  sig: 'cd'.repeat(64),
});

async function saveRecord(): Promise<void> {
  await writeKitRecord(dir, {
    v: 1,
    kitId: 'K'.repeat(22),
    at: 1_800_000_000,
    covers: [A, B],
    names: { [A]: 'default', [B]: 'work' },
    peopleAtSave: { [A]: 2, [B]: 1 },
    exports: { [A]: proof(A, 'n'.repeat(22)), [B]: proof(B, 'm'.repeat(22)) },
    contents: 'full',
    file,
    // UX1113-QA2 N14: a kit that opened with its code (Check); unchecked reads as unfinished.
    checked: true,
  });
}

function contextWith(desk: Partial<LocalUiBackupDesk> | undefined): LocalUiContext {
  return {
    client: { agentId: A } as never,
    recoveryKitAvailable: true,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
    ...(desk === undefined
      ? {}
      : {
          backup: {
            agentlinkDir: dir,
            ids: () =>
              Promise.resolve([
                { name: 'default', label: 'Personal', contacts: 2, agentId: A },
                { name: 'work', label: 'Work', contacts: 1 },
              ]),
            exportRecorded: () => Promise.resolve(true),
            revealer: () => Promise.resolve(true),
            ...desk,
          },
        }),
  } as LocalUiContext;
}

const read = async (context: LocalUiContext) => {
  const route = backupRoutes.find((r) => r.method === 'GET' && r.presence === false);
  if (route === undefined || route.presence !== false) throw new Error('no read route');
  return route.handler(context, { params: {}, query: new URLSearchParams() });
};

describe('GET /api/ui/backup (WP-R2 kit record)', () => {
  it('no record yet', async () => {
    expect(await read(contextWith({}))).toEqual({
      status: 200,
      body: { export: 'available', record: 'none', state: 'none', lastKit: null, missing: null },
    });
  });

  it('backed up: covers both IDs by label; never the path or the kitId', async () => {
    await saveRecord();
    const res = await read(contextWith({}));
    expect(res).toEqual({
      status: 200,
      body: {
        export: 'available',
        record: 'saved',
        state: 'backed_up',
        lastKit: {
          at: 1_800_000_000,
          covers: [
            { name: 'default', label: 'Personal' },
            { name: 'work', label: 'Work' },
          ],
          peopleAtSave: 3,
        },
        missing: { ids: [], people: 0 },
      },
    });
    const text = JSON.stringify(res);
    expect(text).not.toContain(root);
    expect(text).not.toContain('.alkk');
    expect(text).not.toContain('K'.repeat(22));
  });

  it('out of date after an ID and people were added', async () => {
    await saveRecord();
    const res = await read(
      contextWith({
        ids: () =>
          Promise.resolve([
            { name: 'default', label: 'Personal', contacts: 4, agentId: A },
            { name: 'work', label: 'Work', contacts: 1 },
            { name: 'shop', label: 'Shop', contacts: 0 },
          ]),
      }),
    );
    expect(res.body).toMatchObject({
      record: 'saved',
      state: 'out_of_date',
      missing: { ids: [{ name: 'shop', label: 'Shop' }], people: 2 },
    });
  });

  it('a record whose backup.export core does not hold reads as no kit', async () => {
    await saveRecord();
    const asked: [string, unknown, string][] = [];
    const res = await read(
      contextWith({
        exportRecorded: (agentId, signed, kitId) => {
          asked.push([agentId, signed.body['nonce'], kitId]);
          return Promise.resolve(agentId === A ? false : undefined);
        },
      }),
    );
    expect(res.body).toMatchObject({ record: 'none', state: 'none', lastKit: null });
    // WP-R2b (IR L-3): core is asked about the signed save and its kitId, not a bare nonce.
    expect(asked).toContainEqual([A, 'n'.repeat(22), 'K'.repeat(22)]);
  });

  it('a check that cannot run (no covered ID open) keeps the record', async () => {
    await saveRecord();
    const res = await read(contextWith({ exportRecorded: () => Promise.resolve(undefined) }));
    expect(res.body).toMatchObject({ record: 'saved', state: 'backed_up' });
  });

  it('a failing ID list or check never breaks the page: the record is unreadable', async () => {
    await saveRecord();
    const res = await read(contextWith({ ids: () => Promise.reject(new Error('/secret/path')) }));
    expect(res.body).toMatchObject({ record: 'unreadable', state: 'unknown' });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('without the backup desk the record is unreadable (the page keeps its fallback)', async () => {
    expect(await read(contextWith(undefined))).toEqual({
      status: 200,
      body: {
        export: 'available',
        record: 'unreadable',
        state: 'unknown',
        lastKit: null,
        missing: null,
      },
    });
  });
});

describe('Show in Finder for the kit (WP-R2)', () => {
  it('has its own fixed path', () => {
    expect(BACKUP_REVEAL_PATH).toBe('/api/ui/backup/reveal');
  });

  it('reveals the recorded kit file; nothing from the request is used', async () => {
    await saveRecord();
    writeFileSync(file, 'ALKK', { mode: 0o600 });
    const seen: [string, string][] = [];
    const res = await revealKit(
      contextWith({
        revealer: (f, d) => {
          seen.push([f, d]);
          return Promise.resolve(true);
        },
      }),
    );
    expect(res).toEqual({ status: 200, body: { status: 'shown' } });
    expect(seen).toEqual([[file, join(root, 'Downloads')]]);
  });

  it('no record or no file is 404; never a path in the answer', async () => {
    const none = await revealKit(contextWith({}));
    expect(none).toEqual({ status: 404, body: { error: 'not_found' } });
    await saveRecord();
    const gone = await revealKit(contextWith({}));
    expect(gone).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(JSON.stringify(gone)).not.toContain(root);
  });

  it('without the backup desk it is not available', async () => {
    expect(await revealKit(contextWith(undefined))).toEqual({
      status: 501,
      body: { error: 'not_available' },
    });
  });
});
