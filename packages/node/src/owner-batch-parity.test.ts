// M1-8h (IR-M1-9b-1 M-2, IR-M1-8c-1 F-9): node's real `approval.decideBatch` against the M1-2e
// owner-action vectors (test-vectors/owner-action, written by the independent Python generator) and
// against the core verifier (M1-7d). Until now node's batch was checked only for a valid signature;
// a drift in key order, item order or the expiry bound would make every production `approve` fail.
//
// - buildApprovalOperation, the builder decideReviewedWith signs, given the vector's agent, owner,
//   clock and nonce and the reviewed requests in another order, produces the vector's JCS byte for
//   byte, so its bodyHash and signatureInput match too, and the vector's signature verifies over
//   node's body in core.
// - decideReviewedWith itself (a real owner store, the owner code at a scripted prompt) signs a batch
//   that core verifies, and that differs from the vector only in `owner` (the owner key is this
//   test's, not the vector's).
import { readFileSync } from 'node:fs';
import { computeActionDigest, ownerActionSigningParts, verifyOwnerAction } from '@agentlink/core';
import {
  canonicalize,
  decodeBase64url,
  decodeHex,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type JsonValue,
  type OwnerPublicKeys,
} from '@agentlink/crypto';
import { describe, expect, it } from 'vitest';
import type { KeychainBackend } from './keychain.js';
import {
  buildApprovalOperation,
  decideReviewedWith,
  type ReviewedApproval,
} from './owner-approval.js';
import { initOwnerWith } from './owner-init.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';
import type { OwnerTerminal } from './owner-terminal.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

interface Item {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly decision: 'approve' | 'deny';
}
interface Body {
  readonly agent: string;
  readonly owner: string;
  readonly op: string;
  readonly params: { readonly items: readonly Item[] };
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
interface Pending {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly expiresAt: number;
}
interface Case {
  readonly id: string;
  readonly input: {
    readonly body?: Body;
    readonly signed?: { readonly body: Body };
    readonly context?: { readonly now: number; readonly pendingApprovals?: readonly Pending[] };
  };
  readonly expected: {
    readonly jcs?: string;
    readonly bodyHash?: string;
    readonly signatureInput?: string;
    readonly sig?: string;
  };
}

const file = JSON.parse(
  readFileSync(new URL('../../../test-vectors/owner-action/vectors.json', import.meta.url), 'utf8'),
) as { suite: string; cases: Case[] };
const byId = (id: string): Case => {
  const found = file.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`vector ${id} is missing`);
  return found;
};

/** The pending requests the batch vectors name (`verify-batch-*` context), and the verifier's now. */
const verifyContext = byId('verify-batch-20').input.context;
if (verifyContext?.pendingApprovals === undefined) throw new Error('no pending requests');
const PENDING = verifyContext.pendingApprovals;
const NOW = verifyContext.now;

/**
 * The generator's request actions (tools/vectors/generate_owner_action.py): request i is an
 * `agentlink_send_message` to the vectors' other agent with text "batch request i". Node recomputes
 * every actionDigest from the action, so the test needs the preimages; each must hash to a vector
 * digest, or the test fails rather than guessing.
 */
const OTHER_AGENT = byId('reject-wrong-agent').input.signed?.body.agent ?? '';
const ACTIONS = new Map<string, JsonValue>();
for (let i = 0; i <= 20; i += 1) {
  const action = {
    tool: 'agentlink_send_message',
    args: { contact: OTHER_AGENT, text: `batch request ${String(i)}` },
    context: {},
  };
  ACTIONS.set(computeActionDigest(action), action);
}

function reviewedOf(items: readonly Item[]): ReviewedApproval[] {
  return items.map((item) => {
    const action = ACTIONS.get(item.actionDigest);
    const pending = PENDING.find((p) => p.approvalId === item.approvalId);
    if (action === undefined || pending === undefined) {
      throw new Error('a vector item has no known request');
    }
    return {
      approvalId: item.approvalId,
      action,
      storedDigest: item.actionDigest,
      decision: item.decision,
      commitment: false,
      summary: 'Send a message',
      requestExpiresAt: pending.expiresAt,
    };
  });
}

/** Owner keys whose Nostr key is the vector's `owner` (the EVM and enc keys are not signed here). */
const vectorOwner = (body: Body): OwnerPublicKeys => ({
  ownerEvm: randomBytes(20),
  ownerNostr: decodeHex(body.owner, { length: 32 }),
  ownerEnc: randomBytes(32),
});

/** Core's view of the vectors' pending requests, for the match stage. */
const coreContext = (agent: string, ownerNostrHex: string) => ({
  agent,
  ownerNostr: `0x${ownerNostrHex}`,
  now: NOW,
  nonceUsed: () => false,
  approvalRequest: (approvalId: string) => {
    const pending = PENDING.find((p) => p.approvalId === approvalId);
    return pending === undefined
      ? undefined
      : { ...pending, commitment: false, pending: true };
  },
});

class FakeKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

function terminalWith(next: () => string): { terminal: OwnerTerminal; written: string[] } {
  const written: string[] = [];
  return {
    written,
    terminal: {
      write: (text) => void written.push(text),
      readSecret: () => Promise.resolve(encodeUtf8(next())),
      confirm: () => Promise.resolve(true),
      clearScreen: () => void written.push('<clear>'),
    },
  };
}

const BATCHES = ['sign-batch-2', 'sign-batch-20'] as const;

describe('node approval.decideBatch matches the M1-2e vectors byte for byte (M1-8h)', () => {
  it('reads the owner-action suite and its batch signing cases', () => {
    expect(file.suite).toBe('owner-action');
    expect(OTHER_AGENT).toMatch(/^0x[0-9a-f]{40}$/);
    for (const id of BATCHES) expect(byId(id).input.body?.op).toBe('approval.decideBatch');
  });

  for (const id of BATCHES) {
    it(`${id}: the builder gives the vector's JCS, bodyHash and signatureInput`, () => {
      const vector = byId(id);
      const body = vector.input.body as Body;
      // Reviewed in reverse order: node must sort by approvalId bytes itself.
      const reviewed = reviewedOf([...body.params.items].reverse());
      const operation = buildApprovalOperation(
        { agent: body.agent, owner: vectorOwner(body) },
        reviewed,
        { nowSeconds: () => body.issuedAt, nonce: () => decodeBase64url(body.nonce) },
      );
      expect(canonicalize(operation.body)).toBe(vector.expected.jcs);
      const parts = ownerActionSigningParts(operation.body);
      expect(parts.jcs).toBe(vector.expected.jcs);
      expect(encodeHex(parts.bodyHash)).toBe(vector.expected.bodyHash);
      expect(encodeHex(parts.signatureInput)).toBe(vector.expected.signatureInput);
    });

    it(`${id}: the vector's signature over node's body verifies in core`, () => {
      const vector = byId(id);
      const body = vector.input.body as Body;
      const operation = buildApprovalOperation(
        { agent: body.agent, owner: vectorOwner(body) },
        reviewedOf(body.params.items),
        { nowSeconds: () => body.issuedAt, nonce: () => decodeBase64url(body.nonce) },
      );
      const verdict = verifyOwnerAction(
        { body: operation.body, sig: vector.expected.sig },
        coreContext(body.agent, body.owner),
      );
      expect(verdict.ok).toBe(true);
    });

    it(`${id}: decideReviewedWith signs a batch core verifies, equal to the vector but for owner`, async () => {
      const vector = byId(id);
      const body = vector.input.body as Body;
      const keychain = new FakeKeychain();
      let shown = '';
      const setup = terminalWith(() => shown.slice(-4));
      setup.terminal.write = (text) => {
        if (text.startsWith('Your owner code: ')) shown = text.slice('Your owner code: '.length);
      };
      const { owner } = await initOwnerWith(
        keychain,
        setup.terminal,
        { backend: 'keychain', env: {} },
        { kdf: KDF },
      );
      const store = await KeychainOwnerKeyStore.open(keychain, owner);
      const prompt = terminalWith(() => shown);
      const signed = await decideReviewedWith(
        store,
        prompt.terminal,
        { agent: body.agent, owner },
        reviewedOf([...body.params.items].reverse()),
        { nowSeconds: () => body.issuedAt, nonce: () => decodeBase64url(body.nonce) },
      );
      await store.close();
      const ownerHex = encodeHex(owner.ownerNostr);
      expect(canonicalize(signed.body)).toBe(
        canonicalize({ ...(JSON.parse(vector.expected.jcs ?? '') as JsonObject), owner: ownerHex }),
      );
      const verdict = verifyOwnerAction(signed, coreContext(body.agent, ownerHex));
      expect(verdict.ok).toBe(true);
      // The same object for another agent, or with one item dropped, is refused by core.
      expect(
        verifyOwnerAction(signed, coreContext(`0x${'cd'.repeat(20)}`, ownerHex)).ok,
      ).toBe(false);
      const params = signed.body['params'] as { items: JsonObject[] };
      const fewer = {
        body: { ...signed.body, params: { items: params.items.slice(1) } },
        sig: signed.sig,
      };
      expect(verifyOwnerAction(fewer, coreContext(body.agent, ownerHex)).ok).toBe(false);
    });
  }
});
