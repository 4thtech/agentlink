// WP-R2 (D-147 (2), (6), (7); 04 §2.3.3 "In the local app", "Snapshot", "Kit record", "Check that my
// kit opens"): one recovery kit for every ID of this owner, in one owner operation.
//
// - One kitId; core prepares and applies one `backup.export` per ID (each its own audit row), all
//   signed by the one gesture's session; only then is the kit sealed, each ID's store snapshot under
//   its own lock hold, into one file under one new recovery code.
// - If any `backup.export` is refused, nothing is sealed and no record is written.
// - After the seal the record `~/.agentlink/kit-record.json` names the kit, the IDs it covers, the
//   people at save and each ID's `backup.export` nonce; an export handle for Check is issued (the
//   device and inode of the file just created). Nothing is logged.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildOwnerActionBody,
  newOwnerActionNonce,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  encodeHex,
  encodeUtf8,
  type JsonObject,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import { openRecoveryKit } from '@4thtech-io/crypto/keystore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerSigValid, ownerWorld, type OwnerWorld } from './approval-ui.fixture.js';
import { createKeychainAgent } from './keychain-keystore.js';
import { createKitExportHandles, readKitRecord } from './kit-record.js';
import { checkGesture, signGesture } from './owner-operation.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { exportRecoveryKit, type RecoveryKitPeer } from './recovery-kit-export.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

let world: OwnerWorld;
let second: string;
beforeAll(async () => {
  world = await ownerWorld('agentlink-wp-r2-export-');
  second = await createKeychainAgent(world.keychain);
});
afterAll(() => {
  world.cleanup();
});

function memorySink(parts: Uint8Array[]): RecoveryKitStoreSink {
  return {
    write: (b) => void parts.push(b.slice()),
    commit: () => undefined,
    discard: () => undefined,
  };
}

/** A store with a marker row and `people` active contacts (plus one removed). */
function storeAt(dir: string, marker: string, people: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE t (v TEXT); CREATE TABLE contacts (contact_id TEXT, status TEXT);');
  db.prepare('INSERT INTO t VALUES (?)').run(marker);
  for (let i = 0; i < people; i += 1) {
    db.prepare("INSERT INTO contacts VALUES (?, 'active')").run(`c${i}`);
  }
  db.prepare("INSERT INTO contacts VALUES ('gone', 'removed')").run();
  db.close();
  return path;
}

function coreOf(agentId: string, refuse = false) {
  const applied: JsonObject[] = [];
  return {
    applied,
    prepareBackupExport: (kitId: string, contents: 'full' | 'identity') => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const { body } = buildOwnerActionBody({
        agent: agentId,
        owner: encodeHex(world.owner.ownerNostr),
        op: 'backup.export',
        params: { kitId, contents },
        nonce: newOwnerActionNonce(),
        issuedAt,
        expiresAt: issuedAt + 600,
      } as never);
      return Promise.resolve({ status: 'prepared' as const, body });
    },
    apply: (signed: { body: JsonObject; sig: string }): Promise<OwnerActionOutcome> => {
      const body = signed.body;
      if (
        refuse ||
        body['op'] !== 'backup.export' ||
        body['agent'] !== agentId ||
        !ownerSigValid(world.owner, body, signed.sig)
      ) {
        return Promise.resolve({ status: 'refused', op: 'backup.export', reason: 'x' } as never);
      }
      applied.push(body);
      return Promise.resolve({ status: 'applied', op: 'backup.export' } as OwnerActionOutcome);
    },
  };
}

let homes = 0;
async function harness(
  over: {
    refuseSecond?: boolean;
    others?: (peer: RecoveryKitPeer) => readonly RecoveryKitPeer[];
  } = {},
) {
  homes += 1;
  const home = join(world.root, `home-${homes}`);
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  const firstStore = storeAt(join(home, '.agentlink', 'agents', 'default'), 'first', 2);
  const secondStore = storeAt(join(home, '.agentlink', 'agents', 'work'), 'second', 5);
  const firstCore = coreOf(world.agentId);
  const secondCore = coreOf(second, over.refuseSecond === true);
  const ownerStore = await KeychainOwnerKeyStore.open(world.keychain, world.owner);
  const session = await ownerStore.unlockForExport({
    kind: 'passphrase',
    secret: encodeUtf8(world.code),
  });
  const signCalls: number[] = [];
  const peer: RecoveryKitPeer = {
    source: { agentId: second, name: 'work', storePath: secondStore },
    prepareBackupExport: secondCore.prepareBackupExport,
    apply: secondCore.apply,
  };
  const handles = createKitExportHandles();
  const run = () =>
    exportRecoveryKit({
      session,
      ownerStore,
      keychain: world.keychain,
      source: { agentId: world.agentId, name: 'default', storePath: firstStore, home, kdf: KDF },
      client: {
        agentId: world.agentId,
        ownerActions: { prepareBackupExport: firstCore.prepareBackupExport },
      },
      review: { lines: ['Save a recovery kit'] },
      // As the gate does: one checked request per call, signed with this gesture's session.
      sign: async (review, requests) => {
        signCalls.push(requests.length);
        return signGesture(session, checkGesture(review, requests));
      },
      apply: firstCore.apply,
      now: () => Date.now(),
      others: over.others === undefined ? [peer] : over.others(peer),
      handles,
    });
  return {
    home,
    firstCore,
    secondCore,
    signCalls,
    handles,
    run,
    close: async () => {
      await session.close();
      await ownerStore.close();
    },
  };
}

describe('exportRecoveryKit: one kit for every ID (WP-R2)', () => {
  it('a two-ID owner gets one file holding both, one code, one backup.export per ID', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const h = await harness();
    try {
      const outcome = await h.run();
      expect(outcome.status).toBe('saved');
      if (outcome.status !== 'saved') return;
      expect(outcome.covers).toEqual([
        { agentId: world.agentId, name: 'default' },
        { agentId: second, name: 'work' },
      ]);

      // One gesture: each ID's backup.export signed alone, both applied, one kitId.
      expect(h.signCalls).toEqual([1, 1]);
      expect(h.firstCore.applied).toHaveLength(1);
      expect(h.secondCore.applied).toHaveLength(1);
      const kitA = (h.firstCore.applied[0]?.['params'] as JsonObject)['kitId'];
      const kitB = (h.secondCore.applied[0]?.['params'] as JsonObject)['kitId'];
      expect(kitA).toBe(kitB);

      // One file, both IDs, each with its own store snapshot (its own marker row).
      const path = join(h.home, 'Downloads', outcome.file);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
      const kit = await openRecoveryKit(
        new Uint8Array(readFileSync(path)),
        { secret: encodeUtf8(outcome.code), source: 'prompt' },
        {
          createStoreSink: () => memorySink([]),
          expectedOwnerNostr: world.owner.ownerNostr,
        },
      );
      try {
        // Both IDs, each under its own name (the kit keeps its own canonical order).
        expect(
          new Map(kit.agents.map((a) => [a.agentId, Buffer.from(a.name).toString('ascii')])),
        ).toEqual(
          new Map([
            [world.agentId, 'default'],
            [second, 'work'],
          ]),
        );
      } finally {
        kit.wipe();
      }

      // The record: this kit, both IDs, people at save from each snapshot, each ID's nonce.
      const read = await readKitRecord(join(h.home, '.agentlink'));
      expect(read.status).toBe('saved');
      if (read.status !== 'saved') return;
      expect(read.record.kitId).toBe(kitA);
      expect(read.record.covers).toEqual([world.agentId, second]);
      expect(read.record.names).toEqual({ [world.agentId]: 'default', [second]: 'work' });
      expect(read.record.peopleAtSave).toEqual({ [world.agentId]: 2, [second]: 5 });
      expect(read.record.exports).toEqual({
        [world.agentId]: h.firstCore.applied[0]?.['nonce'],
        [second]: h.secondCore.applied[0]?.['nonce'],
      });
      expect(read.record.file).toBe(path);
      expect(read.record.contents).toBe('full');

      // The export handle: single use, the file just created (device and inode), this kitId.
      expect(outcome.check).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const held = h.handles.take(outcome.check as string);
      expect(held).toEqual({
        kitId: kitA,
        path,
        dev: statSync(path).dev,
        ino: statSync(path).ino,
      });

      // Nothing was logged; the code is nowhere but the outcome.
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(readFileSync(join(h.home, '.agentlink', 'kit-record.json'), 'utf8')).not.toContain(
        outcome.code,
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      await h.close();
    }
  });

  it('each ID is snapshotted from its own store (consistent cut per ID)', async () => {
    const h = await harness();
    try {
      const outcome = await h.run();
      if (outcome.status !== 'saved') throw new Error('not saved');
      const path = join(h.home, 'Downloads', outcome.file);
      const parts: Uint8Array[][] = [];
      const kit = await openRecoveryKit(
        new Uint8Array(readFileSync(path)),
        { secret: encodeUtf8(outcome.code), source: 'prompt' },
        {
          createStoreSink: () => {
            const mine: Uint8Array[] = [];
            parts.push(mine);
            return memorySink(mine);
          },
          expectedOwnerNostr: world.owner.ownerNostr,
        },
      );
      // One store sink per ID, in the kit's order.
      const order = kit.agents.map((a) => a.agentId);
      kit.wipe();
      const markers = parts.map((chunks, i) => {
        const file = join(h.home, `snap-${i}.sqlite`);
        writeFileSync(file, Buffer.concat(chunks.map((c) => Buffer.from(c))));
        const db = new Database(file, { readonly: true });
        try {
          return (db.prepare('SELECT v FROM t').get() as { v: string }).v;
        } finally {
          db.close();
        }
      });
      expect(new Map(order.map((agentId, i) => [agentId, markers[i]]))).toEqual(
        new Map([
          [world.agentId, 'first'],
          [second, 'second'],
        ]),
      );
    } finally {
      await h.close();
    }
  });

  it('if any backup.export is refused, nothing is sealed and no record is written', async () => {
    const h = await harness({ refuseSecond: true });
    try {
      const outcome = await h.run();
      expect(outcome).toEqual({ status: 'not_applied' });
      expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
      expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
    } finally {
      await h.close();
    }
  });

  it('refuses a peer naming the open ID, a peer listed twice, and more than 16 IDs, before signing', async () => {
    for (const others of [
      (peer: RecoveryKitPeer) => [{ ...peer, source: { ...peer.source, agentId: world.agentId } }],
      (peer: RecoveryKitPeer) => [peer, peer],
      (peer: RecoveryKitPeer) =>
        Array.from({ length: 16 }, (_, i) => ({
          ...peer,
          source: { ...peer.source, agentId: `0x${String(i + 1).padStart(40, '0')}` },
        })),
    ]) {
      const h = await harness({ others });
      try {
        expect(await h.run()).toEqual({ status: 'failed' });
        expect(h.signCalls).toEqual([]);
        expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
      } finally {
        await h.close();
      }
    }
  });

  // TODO(WP-R1): pending on WP-R1's restore engine (packages/node/src/recovery-kit-restore.ts and
  // the `/api/ui/restore/*` routes), which is not on a branch yet. When it lands: save a kit for a
  // two-ID owner here, run Check on the export handle (`check` with the code still on screen: it
  // opens and lists both IDs, writes nothing), then `open` + `apply` it on a clean temp HOME and
  // assert both IDs come back whole and each ID's policy loads at its mark (snapshot consistency
  // per ID, 04 §2.3.3 "Snapshot").
  it.skip('round trip with WP-R1: one file restores both IDs (pending WP-R1)', async () => {
    const h = await harness();
    try {
      const outcome = await h.run();
      expect(outcome.status).toBe('saved');
      // TODO(WP-R1): check(outcome.check, outcome.code) lists both IDs and writes nothing;
      // open + apply on a clean HOME restores both; each ID's policy loads at its mark.
      expect.fail('pending WP-R1 restore engine');
    } finally {
      await h.close();
    }
  });

  it('with no other IDs it saves the open ID alone (as before)', async () => {
    const h = await harness({ others: () => [] });
    try {
      const outcome = await h.run();
      expect(outcome.status).toBe('saved');
      if (outcome.status !== 'saved') return;
      expect(outcome.covers).toEqual([{ agentId: world.agentId, name: 'default' }]);
      expect(h.secondCore.applied).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
