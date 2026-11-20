// NET-ANNOUNCE-OPTOUT (S2; D-158 (7); 07 §3 "Leaving servers and the announce choice", §4.3
// "Privacy"; 04 §2.3.3; plan risk 1): with the opt-out on, a new computer finds the ID only through
// the owner link or a backup, so a restore from a recovery kit must keep the own list and the choice.
// Proved end to end: an ID on its own servers turns the opt-out on with a real owner-signed
// `network.announce` (core apply), the real KeyExportControl seals a kit, and the restore engine
// restores it on a clean computer (a new HOME and keychain, owner under a new master code). The
// restored ID, opened from the restored store with the new keychain, names the same list and the
// opt-out (so its owner card-update keeps to its own servers, announce-optout.test.ts in core).
import { join } from 'node:path';
import { encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import { AgentLinkClient } from '@4thtech-io/core';
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { openRecordedKeyStore } from './keychain-keystore.js';
import { VirtualPrfAuthenticator } from './passkey-authenticator.fixture.js';
import {
  FAST,
  MemoryKeychain,
  makeAgent,
  makeKit,
  makeOwner,
  tempRoot,
  webauthnCreate,
} from './recovery-kit-restore.fixture.js';
import { createRestoreEngine, type RestoreAnswer } from './recovery-kit-restore.js';

const POSIX = process.platform !== 'win32';
const ORIGIN = 'http://localhost:47821';
/** The fixture's own list (makeAgent): no default and no old default server. */
const OWN = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

let t: Awaited<ReturnType<typeof tempRoot>>;
beforeEach(async () => {
  t = await tempRoot('al-optout-');
});
afterEach(async () => {
  await t.cleanup();
});

const body = (a: RestoreAnswer): Record<string, unknown> => a.body as Record<string, unknown>;

describe.runIf(POSIX)('a restore on a new computer keeps the own list and the opt-out', () => {
  it('the restored ID names the same list and the opt-out', async () => {
    expect(OWN.some((r) => DEFAULT_RELAYS.includes(r) || LEGACY_READ_RELAYS.includes(r))).toBe(
      false,
    );
    const owner = await makeOwner();
    const made = await makeAgent(t.root, owner, 'helper', { announceDefault: false });
    const kit = await makeKit(t.root, owner, [made], undefined, join(t.home, 'Downloads'));

    // A clean computer: a new keychain, nothing under ~/.agentlink.
    const keychain = new MemoryKeychain();
    const engine = createRestoreEngine({
      home: t.home,
      keychain: () => keychain,
      origin: ORIGIN,
      kdf: FAST,
      now: () => 1_800_000_000_000,
      knownOwnerNostr: () => Promise.resolve(undefined),
    });
    try {
      const found = await engine.found('S1');
      const handle = (body(found)['kits'] as { handle: string }[])[0]?.handle as string;
      const opened = await engine.open('S1', { handle }, encodeUtf8(kit.code));
      const kitId = body(opened)['kit'] as string;
      const begun = await engine.applyBegin('S1', {
        kit: kitId,
        selection: [made.agentId],
        names: {},
      });
      expect(body(begun)['status']).toBe('gesture');
      const authenticator = new VirtualPrfAuthenticator({
        credential: newWebauthnTestCredential(),
      });
      const pk = body(begun)['publicKey'] as { challenge: string; userId: string; prfSalt: string };
      const done = await engine.applyFinish(
        'S1',
        { nonce: body(begun)['nonce'] as JsonValue },
        webauthnCreate(authenticator, pk, ORIGIN),
      );
      expect(done.status).toBe(200);
      expect(body(done)['ids']).toMatchObject([{ agentId: made.agentId, outcome: 'restored' }]);
    } finally {
      await engine.close();
    }

    // The restored ID, opened as the app opens it on the new computer.
    const path = join(t.home, '.agentlink', 'agents', 'helper', 'store.sqlite');
    const store = await openAgentStoreWith('keychain', made.agentId, path, { keychain });
    const keyStore = await openRecordedKeyStore('keychain', made.agentId, { keychain });
    try {
      const client = await AgentLinkClient.create({
        keyStore,
        store: store.store,
        cipher: store.cipher,
        approvals: {
          request: (request) => Promise.resolve({ approvalId: request.approvalId }),
          status: () => Promise.resolve({ state: 'pending' }),
        },
        policyMark: store.policyMark,
      });
      expect(await client.identity.relays()).toEqual(OWN);
      expect(await client.identity.announceDefault()).toBe(false);
      expect((await client.identity.signedCard()).relays).toEqual(OWN);
    } finally {
      await keyStore.close();
      await store.close();
    }
  });
});
