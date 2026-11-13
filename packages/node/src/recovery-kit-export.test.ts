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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  AgentLinkClient,
  POLICY_DEFAULTS_EFFECTIVE,
  buildOwnerActionBody,
  newOwnerActionNonce,
  type ApprovalChannel,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import { openRecoveryKit } from '@4thtech-io/crypto/keystore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownerSigValid, ownerWorld, type OwnerWorld } from './approval-ui.fixture.js';
import { openAgentStoreWith } from './agent-store.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import { readKitRecord } from './kit-record.js';
import { checkGesture, signGesture } from './owner-operation.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import { OWNER_SESSION_DEFAULT_TTL_MS } from '@4thtech-io/crypto';
import {
  EXPORT_BUDGET_MS,
  EXPORT_SEAL_MARGIN_MS,
  exportRecoveryKit,
  type RecoveryKitClient,
  type RecoveryKitOthers,
  type RecoveryKitPeer,
} from './recovery-kit-export.js';
import { MemoryKeychain } from './recovery-kit-restore.fixture.js';
import {
  createRestoreEngine,
  createTerminalRestore,
  runRestoreInTerminal,
  type RestoreTerminalText,
} from './recovery-kit-restore.js';

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

/**
 * WP-R2b: the host's walk over the other IDs, one at a time (here: in order, each step awaited before
 * the next; the app host's slot also closes and opens each ID's core around its step).
 */
function visitor(peers: readonly RecoveryKitPeer[]): RecoveryKitOthers {
  return {
    each: async (step) => {
      for (const peer of peers) {
        if (!(await step(peer))) return { ok: false, notIncluded: [] };
      }
      return { ok: true, notIncluded: [] };
    },
  };
}

let homes = 0;
async function harness(
  over: {
    refuseSecond?: boolean;
    others?: (peer: RecoveryKitPeer) => readonly RecoveryKitPeer[];
    /** WP-R2b: the host's walk itself (default: `visitor` over `others`). */
    walk?: (peers: readonly RecoveryKitPeer[]) => RecoveryKitOthers;
    now?: () => number;
    /** KIT-NAMES: what each ID's core `loadLabel` answers (absent: the core has no loadLabel). */
    labels?: { readonly first?: unknown; readonly second?: unknown };
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
    ...(over.labels?.second === undefined
      ? {}
      : { loadLabel: () => Promise.resolve(over.labels?.second as never) }),
  };
  // WP-R2b: the export handle comes from the restore engine (registerExportedKit); recorded here.
  const registered: { path: string; kitId: string }[] = [];
  const run = () =>
    exportRecoveryKit({
      session,
      ownerStore,
      keychain: world.keychain,
      source: { agentId: world.agentId, name: 'default', storePath: firstStore, home, kdf: KDF },
      client: {
        agentId: world.agentId,
        ownerActions: {
          prepareBackupExport: firstCore.prepareBackupExport,
          ...(over.labels?.first === undefined
            ? {}
            : { loadLabel: () => Promise.resolve(over.labels?.first as never) }),
        },
      },
      review: { lines: ['Save a recovery kit'] },
      // As the gate does: one checked request per call, signed with this gesture's session.
      sign: async (review, requests) => {
        signCalls.push(requests.length);
        return signGesture(session, checkGesture(review, requests));
      },
      apply: firstCore.apply,
      now: over.now ?? (() => Date.now()),
      others: (over.walk ?? visitor)(over.others === undefined ? [peer] : over.others(peer)),
      registerCheck: (file) => {
        registered.push({ ...file });
        return Promise.resolve('H'.repeat(22));
      },
    });
  return {
    home,
    firstCore,
    secondCore,
    signCalls,
    registered,
    session,
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
      // WP-R2b (IR L-3): each ID's signed backup.export as its core applied it (body and sig).
      expect(read.record.exports[world.agentId]?.body).toEqual(h.firstCore.applied[0]);
      expect(read.record.exports[second]?.body).toEqual(h.secondCore.applied[0]);
      for (const id of [world.agentId, second]) {
        const proof = read.record.exports[id];
        expect(proof?.sig).toMatch(/^[0-9a-f]{128}$/);
        expect(ownerSigValid(world.owner, proof?.body as JsonObject, proof?.sig as string)).toBe(
          true,
        );
      }
      expect(read.record.file).toBe(path);
      expect(read.record.contents).toBe('full');

      // The export handle (WP-R2b): registered with the restore engine for exactly the file just
      // created and this kitId; the outcome carries only the handle, never the path.
      expect(outcome.check).toBe('H'.repeat(22));
      expect(h.registered).toEqual([{ path, kitId: kitA }]);
      expect(JSON.stringify(outcome)).not.toContain(h.home);

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

  it("KIT-NAMES: the kit carries each ID's verified label inside it; none otherwise", async () => {
    const cases: [unknown, unknown, string | undefined, string | undefined][] = [
      [
        { status: 'verified', label: 'Ana Novak' },
        { status: 'verified', label: 'Work' },
        'Ana Novak',
        'Work',
      ],
      // Unverified, none, or a label outside the folder label rule: no label (the folder shows).
      [{ status: 'unverified' }, { status: 'none' }, undefined, undefined],
      [
        { status: 'verified', label: 'Ana  Novak' },
        { status: 'verified', label: 'Wörk' },
        undefined,
        'Wörk',
      ],
    ];
    for (const [first, secondLabel, wantFirst, wantSecond] of cases) {
      const h = await harness({ labels: { first, second: secondLabel } });
      try {
        const outcome = await h.run();
        expect(outcome.status).toBe('saved');
        if (outcome.status !== 'saved') return;
        const bytes = new Uint8Array(readFileSync(join(h.home, 'Downloads', outcome.file)));
        // Never in the clear: the names are personal data (04 §2.3.3, KIT-NAMES).
        for (const want of [wantFirst, wantSecond]) {
          if (want !== undefined) {
            expect(Buffer.from(bytes).includes(Buffer.from(want, 'utf8'))).toBe(false);
          }
        }
        const kit = await openRecoveryKit(
          bytes,
          { secret: encodeUtf8(outcome.code), source: 'prompt' },
          { createStoreSink: () => memorySink([]), expectedOwnerNostr: world.owner.ownerNostr },
        );
        try {
          const labels = new Map(
            kit.agents.map((a) => [
              a.agentId,
              a.label === undefined ? undefined : Buffer.from(a.label).toString('utf8'),
            ]),
          );
          expect(labels.get(world.agentId)).toBe(wantFirst);
          expect(labels.get(second)).toBe(wantSecond);
        } finally {
          kit.wipe();
        }
        // The outcome and the kit record carry no label.
        expect(JSON.stringify(outcome)).not.toContain('Ana');
        expect(readFileSync(join(h.home, '.agentlink', 'kit-record.json'), 'utf8')).not.toContain(
          'Ana',
        );
      } finally {
        await h.close();
      }
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
      expect(h.registered).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('refuses a peer naming the open ID, a peer listed twice, and more than 16 IDs, before that peer is signed; nothing is sealed', async () => {
    // WP-R2b: the IDs are visited one at a time (at most one core open), so an invalid peer is seen
    // only when its turn comes: the open ID's own backup.export (and any valid earlier peer's) is
    // already signed and applied as an audit row, but the invalid peer is never signed and nothing
    // is sealed or recorded.
    for (const [others, signedBefore] of [
      [
        (peer: RecoveryKitPeer) => [
          { ...peer, source: { ...peer.source, agentId: world.agentId } },
        ],
        1,
      ],
      [(peer: RecoveryKitPeer) => [peer, peer], 2],
      [
        (peer: RecoveryKitPeer) =>
          Array.from({ length: 16 }, (_, i) => ({
            ...peer,
            source: {
              ...peer.source,
              name: `w${String(i)}`,
              agentId: `0x${String(i + 1).padStart(40, '0')}`,
            },
            prepareBackupExport: coreOf(`0x${String(i + 1).padStart(40, '0')}`).prepareBackupExport,
            apply: coreOf(`0x${String(i + 1).padStart(40, '0')}`).apply,
          })),
        16,
      ],
    ] as const) {
      const h = await harness({ others });
      try {
        expect(await h.run()).toEqual({ status: 'failed' });
        expect(h.signCalls).toHaveLength(signedBefore);
        expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
        expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
        expect(h.registered).toEqual([]);
      } finally {
        await h.close();
      }
    }
  });

  it('a walk the host could not finish (an ID not opened, the slot busy) seals nothing', async () => {
    const h = await harness({
      walk: (peers) => ({
        each: async (step) => {
          for (const peer of peers) await step(peer);
          return { ok: false, notIncluded: [] };
        },
      }),
    });
    try {
      expect(await h.run()).toEqual({ status: 'not_applied' });
      expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
      expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
    } finally {
      await h.close();
    }
  });

  it('IDs the host could not include (a file-KeyStore ID) are named in the outcome, never sealed', async () => {
    const h = await harness({
      walk: (peers) => ({
        each: async (step) => {
          for (const peer of peers) if (!(await step(peer))) return { ok: false, notIncluded: [] };
          return {
            ok: true,
            notIncluded: [
              { name: 'files', reason: 'file_keystore' as const },
              { name: 'Bad Name', reason: 'file_keystore' as const },
              { name: 'odd', reason: 'because' as never },
            ],
          };
        },
      }),
    });
    try {
      const outcome = await h.run();
      expect(outcome.status).toBe('saved');
      if (outcome.status !== 'saved') return;
      // IR L-1: each with its fixed reason; anything else the host might pass is dropped.
      expect(outcome.notIncluded).toEqual([{ name: 'files', reason: 'file_keystore' }]);
      const read = await readKitRecord(join(h.home, '.agentlink'));
      expect(read.status === 'saved' && read.record.covers).toEqual([world.agentId, second]);
    } finally {
      await h.close();
    }
  });

  it('past its time budget the operation signs no further ID and seals nothing', async () => {
    let t = Date.now();
    const h = await harness({
      // Each read of the clock moves it on by 15 s: the second ID's turn is past the 40 s budget.
      now: () => (t += 15_000),
    });
    try {
      expect(await h.run()).toEqual({ status: 'not_applied' });
      expect(h.signCalls.length).toBeLessThan(2);
      expect(h.secondCore.applied).toEqual([]);
      expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('the walk budget plus the seal margin fits inside the export session (IR M-1)', async () => {
    expect(EXPORT_BUDGET_MS + EXPORT_SEAL_MARGIN_MS).toBeLessThanOrEqual(
      OWNER_SESSION_DEFAULT_TTL_MS,
    );
    // The host is told the deadline: the budget from the gesture on.
    let seen: number | undefined;
    const t = 1_000_000;
    const h = await harness({
      now: () => t,
      walk: (peers) => ({
        each: async (step, bounds) => {
          seen = bounds.deadlineAt;
          for (const peer of peers) if (!(await step(peer))) return { ok: false, notIncluded: [] };
          return { ok: true, notIncluded: [] };
        },
      }),
    });
    try {
      expect((await h.run()).status).toBe('saved');
      expect(seen).toBe(t + EXPORT_BUDGET_MS);
    } finally {
      await h.close();
    }
  });

  it('the export session ending mid-walk signs nothing more and seals nothing (IR M-1)', async () => {
    const h = await harness({
      walk: (peers) => ({
        each: async (step) => {
          // The session expires while the host opens the next ID.
          await h.session.close();
          for (const peer of peers) if (!(await step(peer))) return { ok: false, notIncluded: [] };
          return { ok: true, notIncluded: [] };
        },
      }),
    });
    try {
      expect(await h.run()).toEqual({ status: 'not_applied' });
      expect(h.secondCore.applied).toEqual([]);
      expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
      expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
    } finally {
      await h.close();
    }
  });

  it('a step still running when the host gave up (timeout) signs and applies no more', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<boolean> | undefined;
    const h = await harness({
      walk: (peers) => ({
        each: (step) => {
          const peer = peers[0] as RecoveryKitPeer;
          // The host's per-step timeout fires while the peer's prepare is still running.
          late = step({
            ...peer,
            prepareBackupExport: async (k, c) => {
              await held;
              return peer.prepareBackupExport(k, c);
            },
          });
          return Promise.resolve({ ok: false, notIncluded: [] });
        },
      }),
    });
    try {
      expect(await h.run()).toEqual({ status: 'not_applied' });
      release();
      expect(await late).toBe(false);
      expect(h.signCalls).toHaveLength(1);
      expect(h.secondCore.applied).toEqual([]);
      expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
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

// WP-R2b: the R1 <-> R2 round trip with real cores. A two-ID owner saves one kit through
// exportRecoveryKit (each ID's real core prepares and applies its backup.export; the other ID's core
// is opened alone, after the open one is closed, as the app host does); Check opens it through the
// restore engine's export handle; `agentlink restore` on a fresh temp HOME and an empty keychain
// brings both IDs back, and each ID's signed policy loads at its own mark (R1 deviation 5: the
// snapshot and the policy-version mark are one cut per ID, 04 §2.3.3 "Snapshot").
describe.runIf(process.platform !== 'win32')('round trip with WP-R1 (real cores)', () => {
  const RELAYS = ['wss://relay.agentlink.dev', 'wss://nos.lol'];
  const approvals: ApprovalChannel = {
    request: (request) => Promise.resolve({ approvalId: request.approvalId }),
    status: () => Promise.resolve({ state: 'pending' }),
  };
  const TEXT: RestoreTerminalText = {
    noKit: 'no kit',
    pickKit: 'which',
    kitLine: (n, name) => `${String(n)} ${name}`,
    errors: new Proxy(
      {},
      { get: (_t, k) => `error ${String(k)}` },
    ) as RestoreTerminalText['errors'],
    masterCodePrompt: 'master code',
    recoveryCodePrompt: 'recovery code',
    checkOpens: 'This kit opens.',
    idLine: (name, state, people) => `${name} ${state} ${String(people)}`,
    newName: (name, suggested) => `rename ${name} ${suggested}`,
    confirm: (n) => `restore ${String(n)}?`,
    nothingToRestore: 'nothing',
    outcomeLine: (name, outcome) => `${name} ${outcome}`,
    masterCodeShown: 'new master code:',
    savedIt: 'saved?',
    nextSteps: 'next',
  };

  /** One ID's real core over its own store and keychain items (the CLI's openAgent, reduced). */
  async function openCore(keychain: MemoryKeychain, agentId: string, path: string, clock: number) {
    const store = await openAgentStoreWith('keychain', agentId, path, { keychain });
    const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
    const client = await AgentLinkClient.create({
      keyStore,
      store: store.store,
      cipher: store.cipher,
      approvals,
      clock: () => clock,
      policyMark: store.policyMark,
    });
    return {
      client,
      close: async () => {
        await keyStore.close();
        await store.close();
      },
    };
  }

  it('a two-ID owner saves one kit; Check opens it; restore on a fresh HOME brings both back at their policy marks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlink-wp-r2b-roundtrip-'));
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, 'Downloads'), { recursive: true });
      const keychain = new MemoryKeychain();
      const written: string[] = [];
      const shown = (): string =>
        (written.find((x) => x.startsWith('Your master code: ')) ?? '').slice(
          'Your master code: '.length,
        );
      const { owner } = await initOwnerWith(
        keychain,
        {
          write: (text) => void written.push(text),
          readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
          confirm: () => Promise.resolve(false),
          clearScreen: () => undefined,
        },
        { backend: 'keychain', env: {} },
        { kdf: KDF },
      );
      const ownerCode = shown();
      const clock = Math.floor(Date.now() / 1000);
      const ids = [
        { name: 'default', version: 2, agentId: '', path: '' },
        { name: 'work', version: 3, agentId: '', path: '' },
      ];
      for (const id of ids) {
        id.agentId = await createKeychainAgent(keychain);
        const dir = join(home, '.agentlink', 'agents', id.name);
        mkdirSync(dir, { recursive: true });
        id.path = join(dir, 'store.sqlite');
        const core = await openCore(keychain, id.agentId, id.path, clock);
        const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
        const session = await ownerStore.unlock({
          kind: 'passphrase',
          secret: encodeUtf8(ownerCode),
        });
        try {
          await core.client.identity.init({
            owner: session,
            ownerKeys: owner,
            name: id.name,
            relays: RELAYS,
          });
          const policy = structuredClone(
            (POLICY_DEFAULTS_EFFECTIVE as { policy: unknown }).policy,
          ) as JsonObject;
          const body = {
            v: 1,
            agent: id.agentId,
            owner: encodeHex(owner.ownerNostr),
            op: 'policy.set',
            params: { version: id.version, policy },
            nonce: encodeBase64url(randomBytes(16)),
            issuedAt: clock,
            expiresAt: clock + 600,
          } as JsonObject;
          const applied = await core.client.ownerActions.apply({
            body,
            sig: await session.signOwnerAction(body),
          });
          expect(applied).toMatchObject({ status: 'applied', policyVersion: id.version });
        } finally {
          await session.close();
          await ownerStore.close();
          await core.close();
        }
      }
      const [first, other] = ids as [(typeof ids)[number], (typeof ids)[number]];

      // The save: the open ID's core first; then it is closed and the other ID's core is opened
      // alone (at most one open at any time), as the app host's slot does.
      let open = 0;
      let most = 0;
      const opened = async (id: (typeof ids)[number]) => {
        open += 1;
        most = Math.max(most, open);
        const core = await openCore(keychain, id.agentId, id.path, clock);
        return {
          client: core.client,
          close: async () => {
            await core.close();
            open -= 1;
          },
        };
      };
      const firstCore = await opened(first);
      const restoreHere = createRestoreEngine({
        home,
        keychain: () => keychain,
        origin: 'http://localhost:47821',
        kdf: KDF,
        knownOwnerNostr: () => Promise.resolve(owner.ownerNostr),
      });
      const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
      const session = await ownerStore.unlockForExport({
        kind: 'passphrase',
        secret: encodeUtf8(ownerCode),
      });
      let outcome: Awaited<ReturnType<typeof exportRecoveryKit>>;
      try {
        outcome = await exportRecoveryKit({
          session,
          ownerStore,
          keychain,
          source: {
            agentId: first.agentId,
            name: first.name,
            storePath: first.path,
            home,
            kdf: KDF,
          },
          client: firstCore.client as unknown as RecoveryKitClient,
          review: { lines: ['Save a recovery kit'] },
          sign: (review, requests) => signGesture(session, checkGesture(review, requests)),
          apply: (signed) => firstCore.client.ownerActions.apply(signed),
          now: () => Date.now(),
          others: {
            each: async (step) => {
              await firstCore.close();
              const core = await opened(other);
              try {
                const ok = await step({
                  source: { agentId: other.agentId, name: other.name, storePath: other.path },
                  prepareBackupExport: (kitId, contents) =>
                    core.client.ownerActions.prepareBackupExport(kitId, contents),
                  apply: (signed) => core.client.ownerActions.apply(signed),
                });
                return { ok, notIncluded: [] };
              } finally {
                await core.close();
              }
            },
          },
          registerCheck: (file) => restoreHere.registerExportedKit('S1', file),
        });
      } finally {
        await session.close();
        await ownerStore.close();
      }
      expect(most).toBe(1);
      expect(open).toBe(0);
      expect(outcome.status).toBe('saved');
      if (outcome.status !== 'saved') return;
      expect(outcome.covers.map((c) => c.name)).toEqual(['default', 'work']);

      // Each ID's core holds its own backup.export row; the record's nonces name them.
      const read = await readKitRecord(join(home, '.agentlink'));
      if (read.status !== 'saved') throw new Error('no record');
      for (const id of ids) {
        const core = await openCore(keychain, id.agentId, id.path, clock);
        try {
          expect(
            await core.client.ownerActions.backupExportRecorded(
              read.record.exports[id.agentId],
              read.record.kitId,
            ),
          ).toBe(true);
          // IR L-3: the same signed save under another kitId is not this save.
          expect(
            await core.client.ownerActions.backupExportRecorded(
              read.record.exports[id.agentId],
              'Z'.repeat(22),
            ),
          ).toBe(false);
        } finally {
          await core.close();
        }
      }

      // Check that my kit opens: the export handle and the code still on screen; writes nothing.
      const checked = await restoreHere.check(
        'S1',
        { handle: outcome.check as string },
        encodeUtf8(outcome.code),
      );
      expect(checked.status).toBe(200);
      const summary = (checked.body as { summary: { ids: { name: string }[] } }).summary;
      expect(summary.ids.map((i) => i.name).sort()).toEqual(['default', 'work']);
      await restoreHere.close();

      // Restore on a fresh HOME with an empty keychain (the terminal's restore).
      const fresh = join(root, 'fresh');
      mkdirSync(join(fresh, 'Downloads'), { recursive: true });
      const kitPath = join(home, 'Downloads', outcome.file);
      const freshKeychain = new MemoryKeychain();
      const answers = [outcome.code, 'yes', 'yes'];
      const restored = await runRestoreInTerminal(
        createTerminalRestore({
          home: fresh,
          keychain: () => freshKeychain,
          origin: 'terminal',
          kdf: KDF,
        }),
        {
          write: () => undefined,
          readSecret: () => Promise.resolve(encodeUtf8(answers.shift() ?? '')),
          confirm: () => Promise.resolve(/^y/i.test(answers.shift() ?? '')),
          readText: () => Promise.resolve(answers.shift() ?? ''),
          clearScreen: () => undefined,
        },
        { file: kitPath, check: false },
        TEXT,
      );
      expect(restored).toBe('restored');

      // Both IDs are back, each with its signed policy at its own mark.
      for (const id of ids) {
        const path = join(fresh, '.agentlink', 'agents', id.name, 'store.sqlite');
        const core = await openCore(freshKeychain, id.agentId, path, clock);
        try {
          expect(await core.client.ownerActions.loadPolicy()).toMatchObject({
            mode: 'signed',
            version: id.version,
          });
        } finally {
          await core.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
