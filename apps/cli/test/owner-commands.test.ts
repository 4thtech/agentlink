// M1-9b: the owner commands `owner init`, `approve` (one request and one agent's list), `deny` and
// `cancel` (04 §2.5, §2.5.1, §2.5.2; 06 §2.5 step 3, §8; 11 §6.10; D-67, D-68, D-73 (3)).
//
// End to end with the real core (M1-7d owner actions, M1-7e approvals) over an in-memory store. The
// owner signature comes from the crypto test seam (MemoryOwnerKeyStore), standing in for
// @4thtech-io/node's TTY prompt (M1-8c), which these tests cannot drive. The production wiring is
// checked separately: without a TTY it refuses before anything is read or signed.
import {
  AgentLinkClient,
  MemoryStore,
  computeActionDigest,
  rowKeyOf,
  type ApprovalChannel,
  type Sealed,
  type SealContext,
  type StoreCipher,
} from '@4thtech-io/core';
import {
  KeyStoreError,
  canonicalize,
  decodeBase64url,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  sha256,
  type JsonObject,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import {
  NodeKeyStoreError,
  type ApprovalContext,
  type OwnerSetupOptions,
  type ReviewedApproval,
} from '@4thtech-io/node';
import { describe, expect, it } from 'vitest';
import {
  nodeOwnerDeps,
  ownerCommandHandlers,
  type OwnerAgent,
  type OwnerCommandDeps,
} from '../src/commands/owner/index.js';
import { OWNER_TEXT } from '../src/commands/owner/strings.js';
import { createDispatcher, DISPATCH_TEXT } from '../src/dispatch.js';
import { createOutput } from '../src/output.js';
import {
  CUT_MARKER,
  MAX_LINE_CODE_POINTS,
  MAX_REGION_LINES,
  REGION_END,
  REGION_PREFIX,
} from '../src/terminal/sanitize.js';

const T0 = 1_800_000_000;
const silent = createLogger({ name: 'test', sink: () => undefined });
const presence = () => ({ kind: 'passphrase' as const, secret: encodeUtf8('correct horse') });

/** NOT encryption: binds a value to its table, column and row key so tests see sealing (07 §3.1). */
class TestCipher implements StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed> {
    const body = JSON.stringify([context.table, context.column, context.rowKey, plaintext]);
    return Promise.resolve(`t:${encodeBase64url(encodeUtf8(body))}` as Sealed);
  }
  open(context: SealContext, sealed: Sealed): Promise<string> {
    return Promise.resolve().then(() => {
      const parsed = JSON.parse(decodeUtf8(decodeBase64url(sealed.slice(2)))) as unknown[];
      if (
        parsed[0] !== context.table ||
        parsed[1] !== context.column ||
        parsed[2] !== context.rowKey
      )
        throw new Error('test cipher: wrong context');
      return parsed[3] as string;
    });
  }
  indexDigest(data: Uint8Array): Promise<string> {
    return Promise.resolve(encodeHex(sha256(data)));
  }
}

const channel: ApprovalChannel = {
  request: (r) => Promise.resolve({ approvalId: r.approvalId }),
  status: () => Promise.resolve({ state: 'unknown' }),
};

const evm = (): string => `0x${encodeHex(randomBytes(20))}`;

/** A valid `agentlink_send` action (types approval.ts): `args` are what the agent chose. */
function sendAction(args: JsonObject): JsonObject {
  return {
    tool: 'agentlink_send',
    args,
    context: {
      triggers: ['proofs.notarize'],
      counterparty: { agentId: evm(), ownerKey: encodeHex(randomBytes(32)) },
      file: null,
      fee: { token: evm(), amount: '100000', usd: '0.1' },
    },
  };
}

interface World {
  t: number;
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestCipher;
  readonly owner: MemoryOwnerKeyStore;
  readonly out: string[];
  readonly err: string[];
  /** Every owner-code entry: one per owner operation (no unlock session, D-68). */
  readonly codeEntries: { op: string; reviewed?: readonly ReviewedApproval[] }[];
  readonly answers: string[];
  readonly asked: string[];
  readonly inits: OwnerSetupOptions[];
  onAsk?: (question: string) => Promise<void>;
  request(
    args?: JsonObject,
  ): Promise<{ approvalId: string; action: JsonObject; actionDigest: string }>;
  run(
    argv: string[],
    terminal?: Partial<{ stdinIsTTY: boolean; stdoutIsTTY: boolean; env: Record<string, string> }>,
  ): Promise<number>;
  deps: OwnerCommandDeps;
  signDecision(items: JsonObject[], op?: string): Promise<{ body: JsonObject; sig: string }>;
}

async function world(): Promise<World> {
  const store = new MemoryStore();
  const cipher = new TestCipher();
  const owner = new MemoryOwnerKeyStore(new Uint8Array(32).fill(101), presence());
  const w = {
    t: T0,
    out: [] as string[],
    err: [] as string[],
    codeEntries: [] as World['codeEntries'],
    answers: [] as string[],
    asked: [] as string[],
    inits: [] as OwnerSetupOptions[],
  } as unknown as World;
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(new Uint8Array(32).fill(1)),
    store,
    cipher,
    approvals: channel,
    clock: () => w.t,
    logger: silent,
    policyMark: { read: () => Promise.resolve(0), raise: (v: number) => Promise.resolve(v) },
  });
  const session = await owner.unlock(presence());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: ['wss://relay.agentlink.dev', 'wss://nos.lol'],
  });
  await session.close();
  const ownerHex = encodeHex((await owner.getPublicKeys()).ownerNostr);

  const sign = async (body: JsonObject) => {
    const s = await owner.unlock(presence());
    try {
      return { body, sig: await s.signOwnerAction(body) };
    } finally {
      await s.close();
    }
  };

  const agent: OwnerAgent = {
    name: 'default',
    client,
    store,
    cipher,
    close: () => Promise.resolve(),
  };

  const deps: OwnerCommandDeps = {
    listAgents: () => Promise.resolve(['default']),
    open: () => Promise.resolve({ status: 'ok', agent }),
    backendOf: () => Promise.resolve('keychain'),
    initOwner: (options) => {
      w.inits.push(options);
      if (options.cardOwner !== undefined) {
        return Promise.reject(
          new NodeKeyStoreError(
            'owner_exists',
            "This agent already has an owner. AgentLink won't replace it.",
          ),
        );
      }
      return Promise.reject(new Error('not reached in these tests'));
    },
    // Stands in for @4thtech-io/node's decideReviewedApprovals: one code entry, one signed object
    // built from exactly the reviewed items, with the digest recomputed from each action.
    addAgent: () => Promise.reject(new Error('not used')),
    changeOwnerCode: () => Promise.reject(new Error('not used')),
    decide: async (context: ApprovalContext, reviewed: readonly ReviewedApproval[]) => {
      w.codeEntries.push({ op: 'decide', reviewed });
      const items = reviewed
        .map((r) => {
          const actionDigest = computeActionDigest(r.action);
          if (actionDigest !== r.storedDigest) throw new Error('digest mismatch offered');
          return { approvalId: r.approvalId, actionDigest, decision: r.decision };
        })
        .sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1));
      const single = items.length === 1;
      return sign({
        v: 1,
        agent: context.agent,
        owner: encodeHex(context.owner.ownerNostr),
        op: single ? 'approval.decide' : 'approval.decideBatch',
        params: single ? (items[0] as JsonObject) : { items },
        nonce: encodeBase64url(randomBytes(16)),
        issuedAt: w.t,
        expiresAt: Math.min(w.t + 600, ...reviewed.map((r) => r.requestExpiresAt)),
      });
    },
    signOwnerAction: async (_owner, item) => {
      w.codeEntries.push({ op: 'sign' });
      if (item.kind !== 'owner-action') throw new Error('unexpected');
      return { kind: 'owner-action', signed: await sign(item.action) };
    },
    ask: async (question) => {
      w.asked.push(question);
      await w.onAsk?.(question);
      return w.answers.shift() ?? '';
    },
    now: () => w.t,
    cardRelays: () => ['wss://relay.agentlink.dev', 'wss://nos.lol'],
  };

  const dispatch = createDispatcher(ownerCommandHandlers(deps));
  Object.assign(w, {
    client,
    store,
    cipher,
    owner,
    deps,
    request: async (args: JsonObject = { to: 'Ana', text: 'hello' }) => {
      const action = sendAction(args);
      const pending = await client.approvalService.request({
        action,
        summary: 'Send a message to a contact',
      });
      return { approvalId: pending.approvalId, action, actionDigest: pending.actionDigest };
    },
    run: (argv: string[], terminal = {}) =>
      dispatch(argv, {
        output: createOutput({ log: (l) => w.out.push(l), error: (l) => w.err.push(l) }),
        terminal: { stdinIsTTY: true, stdoutIsTTY: true, env: {}, ...terminal },
        version: '0.0.0',
      }),
    signDecision: (items: JsonObject[], op = 'approval.decide') =>
      sign({
        v: 1,
        agent: client.agentId,
        owner: ownerHex,
        op,
        params: op === 'approval.decide' ? (items[0] as JsonObject) : { items },
        nonce: encodeBase64url(randomBytes(16)),
        issuedAt: w.t,
        expiresAt: w.t + 600,
      }),
  });
  return w;
}

const use = (w: World, r: { approvalId: string; action: JsonObject }) =>
  w.client.approvalService.use(r.approvalId, r.action, 'approval');

const row = (w: World, approvalId: string) =>
  w.store.transaction((tx) => tx.get('approvals', { approval_id: approvalId }));

/** Writes a pending row directly, for states a tool call cannot make (a damaged or scoped row). */
async function insertRow(
  w: World,
  actionText: string,
  options: { scopeJson?: string | null } = {},
): Promise<string> {
  const approvalId = `apr_${encodeBase64url(randomBytes(16))}`;
  const key = rowKeyOf([approvalId]);
  const action = await w.cipher.seal(
    { table: 'approvals', column: 'action_json', rowKey: key },
    actionText,
  );
  const summary = await w.cipher.seal(
    { table: 'approvals', column: 'summary', rowKey: key },
    'Send a message',
  );
  await w.store.transaction((tx) =>
    tx.insert('approvals', {
      approval_id: approvalId,
      action_json: action,
      scope_json: options.scopeJson ?? null,
      answers_envelope_id: null,
      scope_key: null,
      source: 'owner',
      policy_hash: null,
      signed_decision: null,
      signed_cancel: null,
      summary,
      status: 'pending',
      expires_at: w.t + 3600,
      created_at: w.t,
      decided_at: null,
    }),
  );
  return approvalId;
}

describe('an agent without a terminal can never approve (04 §2.5, 06 §8; UX guard, D-67)', () => {
  for (const argv of [
    ['approve'],
    ['approve', 'apr_AAAAAAAAAAAAAAAAAAAAAA'],
    ['deny', 'apr_AAAAAAAAAAAAAAAAAAAAAA'],
    ['cancel', 'apr_AAAAAAAAAAAAAAAAAAAAAA'],
    ['owner', 'init'],
  ]) {
    it(`refuses \`${argv.join(' ')}\` with piped stdin, and with a harness marker, before anything opens`, async () => {
      const w = await world();
      const r = await w.request();
      let opened = 0;
      w.deps.open = () => {
        opened += 1;
        return Promise.reject(new Error('must not open'));
      };
      expect(await w.run(argv, { stdinIsTTY: false })).toBe(1);
      expect(await w.run(argv, { stdoutIsTTY: false })).toBe(1);
      expect(await w.run(argv, { env: { CLAUDECODE: '1' } })).toBe(1);
      expect(w.err).toEqual([
        DISPATCH_TEXT.notInteractive,
        DISPATCH_TEXT.notInteractive,
        DISPATCH_TEXT.harnessDetected,
      ]);
      expect(opened).toBe(0);
      expect(w.codeEntries).toEqual([]);
      expect((await row(w, r.approvalId))?.status).toBe('pending');
    });
  }

  it('never takes the owner code from an argument or the environment', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', r.approvalId, '--code', 'ABCD-EFGH'])).toBe(2);
    expect(await w.run(['approve', r.approvalId, '--passphrase=x'])).toBe(2);
    expect(w.err).toEqual([DISPATCH_TEXT.badArguments, DISPATCH_TEXT.badArguments]);
    expect(w.err.join('\n')).not.toContain('ABCD');
    expect(w.codeEntries).toEqual([]);
  });

  it('the production wiring refuses without an interactive terminal before reading or signing', async () => {
    // Vitest's stdin is a pipe: @4thtech-io/node's TTY prompt refuses (or the harness marker does).
    const deps = nodeOwnerDeps('/nonexistent-home-for-test');
    const refused = ['owner_prompt_unavailable', 'harness_detected'];
    const owner = {
      ownerEvm: new Uint8Array(20).fill(1),
      ownerNostr: new Uint8Array(32).fill(2),
      ownerEnc: new Uint8Array(32).fill(3),
    };
    const reviewed: ReviewedApproval = {
      approvalId: `apr_${encodeBase64url(randomBytes(16))}`,
      action: { a: 1 },
      storedDigest: encodeHex(sha256(encodeUtf8(canonicalize({ a: 1 })))),
      decision: 'approve',
      commitment: false,
      summary: 'Send a message',
      requestExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const codeOf = (e: unknown) => (e instanceof NodeKeyStoreError ? e.code : 'other');
    const a = await deps.decide({ agent: evm(), owner }, [reviewed]).catch(codeOf);
    const b = await deps
      // M1-8h: an allowlisted op, so the request reaches the terminal checks (an op outside the
      // allowlist is refused even earlier, owner-allowlist.test.ts in @4thtech-io/node).
      .signOwnerAction(owner, {
        kind: 'owner-action',
        action: { v: 1, op: 'approval.cancel' },
        summary: 'Cancel',
      })
      .catch(codeOf);
    const c = await deps
      .initOwner({
        backend: 'keychain',
        env: {},
        firstCard: {
          agent: evm(),
          name: 'Agent',
          relays: ['wss://relay.agentlink.dev', 'wss://nos.lol'],
          identity: {
            get: () => Promise.resolve(undefined),
            init: () => Promise.reject(new Error('not reached')),
          },
        },
      })
      .catch(codeOf);
    expect(refused).toContain(a);
    expect(refused).toContain(b);
    expect(refused).toContain(c);
  });
});

describe('approve <id> and deny <id> (06 §2.5 step 3, D-73 (3))', () => {
  it('lets exactly the pending action proceed once', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    expect(w.codeEntries).toHaveLength(1);
    const reviewed = w.codeEntries[0]?.reviewed ?? [];
    expect(reviewed.map((i) => [i.approvalId, i.decision, i.commitment])).toEqual([
      [r.approvalId, 'approve', false],
    ]);
    // The signed digest is the one recomputed from the action that was displayed (IR-M1-9j-1 F06).
    expect(computeActionDigest(reviewed[0]?.action)).toBe(r.actionDigest);
    expect(await use(w, r)).toEqual({ status: 'used' });
    expect((await use(w, r)).status).not.toBe('used');
    expect(w.out.some((l) => l.startsWith('OK       Approved: '))).toBe(true);
    expect(w.out).toContain("Your AI can't approve for you.");
  });

  it('a different action cannot use the approval', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    const other = { ...r, action: sendAction({ to: 'Ana', text: 'something else' }) };
    expect((await use(w, other)).status).not.toBe('used');
    expect(await use(w, r)).toEqual({ status: 'used' });
  });

  it('deny <id> denies it: nothing proceeds', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['deny', r.approvalId])).toBe(0);
    expect(w.codeEntries[0]?.reviewed?.[0]?.decision).toBe('deny');
    expect(await w.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'denied',
    });
    expect((await use(w, r)).status).not.toBe('used');
    expect(w.out.some((l) => l.startsWith('OK       Denied: '))).toBe(true);
  });

  it('refuses an unknown or already decided ID with fixed text, without asking for the code', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', `apr_${encodeBase64url(randomBytes(16))}`])).toBe(1);
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    expect(await w.run(['deny', r.approvalId])).toBe(1);
    expect(w.codeEntries).toHaveLength(1);
    expect(w.err.join('\n')).not.toContain(r.approvalId);
  });

  it('a request whose stored digest does not match its action is a problem and is never offered', async () => {
    const w = await world();
    const action = sendAction({ to: 'Ana', text: 'hi' });
    // Not the JCS text: its own hash differs from the digest recomputed from the parsed action.
    const id = await insertRow(w, JSON.stringify(action, null, 1));
    expect(await w.run(['approve', id])).toBe(1);
    expect(w.err.some((l) => l.startsWith('Problem'))).toBe(true);
    expect(w.codeEntries).toEqual([]);
  });

  it('a stored action that fails its strict schema is a problem and is never offered', async () => {
    const w = await world();
    const id = await insertRow(w, canonicalize({ tool: 'agentlink_send', args: {}, context: {} }));
    expect(await w.run(['approve', id])).toBe(1);
    expect(w.codeEntries).toEqual([]);
  });

  it('asks for the owner code again at every run: one entry, one owner operation', async () => {
    const w = await world();
    const a = await w.request();
    const b = await w.request();
    expect(await w.run(['approve', a.approvalId])).toBe(0);
    expect(await w.run(['approve', b.approvalId])).toBe(0);
    expect(w.codeEntries).toHaveLength(2);
  });
});

describe('approve with no ID: one agent list, one owner code entry (D-68, 04 §2.5.2)', () => {
  it('three requests approved with one entry; each proceeds exactly once', async () => {
    const w = await world();
    const rs = [await w.request(), await w.request(), await w.request()];
    w.answers.push('a', 'a', 'a');
    expect(await w.run(['approve'])).toBe(0);
    expect(w.codeEntries).toHaveLength(1);
    expect(w.asked).toEqual([
      'Approve, deny or later? (a/d/L)',
      'Approve, deny or later? (a/d/L)',
      'Approve, deny or later? (a/d/L)',
    ]);
    expect(w.out[0]).toBe('Waiting for you: 3');
    for (const r of rs) {
      expect(await use(w, r)).toEqual({ status: 'used' });
      expect((await use(w, r)).status).not.toBe('used');
    }
    expect(w.out.filter((l) => l.startsWith('OK       Approved: '))).toHaveLength(3);
  });

  it('later leaves a request pending; approve and deny are signed together', async () => {
    const w = await world();
    const [a, b, c] = [await w.request(), await w.request(), await w.request()];
    w.answers.push('a', 'd', '');
    expect(await w.run(['approve'])).toBe(0);
    const decided = (w.codeEntries[0]?.reviewed ?? []).map((i) => i.decision).sort();
    expect(decided).toEqual(['approve', 'deny']);
    const statuses = await Promise.all(
      [a, b, c].map(async (r) => (await row(w, r!.approvalId))?.status),
    );
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(1);
  });

  it('a request the agent raises during the review is not signed and stays pending', async () => {
    const w = await world();
    await w.request();
    await w.request();
    let late: { approvalId: string } | undefined;
    w.onAsk = async () => {
      if (late === undefined) late = await w.request();
    };
    w.answers.push('a', 'a');
    expect(await w.run(['approve'])).toBe(0);
    const signedIds = (w.codeEntries[0]?.reviewed ?? []).map((i) => i.approvalId);
    expect(signedIds).toHaveLength(2);
    expect(signedIds).not.toContain(late?.approvalId);
    expect((await row(w, late!.approvalId))?.status).toBe('pending');
  });

  it('drops a request decided elsewhere during the review, with a notice', async () => {
    const w = await world();
    const a = await w.request();
    const b = await w.request();
    let asks = 0;
    w.onAsk = async () => {
      asks += 1;
      if (asks !== 2) return;
      // Another surface denies `a` while the owner is still reviewing.
      const signed = await w.signDecision([
        { approvalId: a.approvalId, actionDigest: a.actionDigest, decision: 'deny' },
      ]);
      expect((await w.client.ownerActions.apply(signed)).status).toBe('applied');
    };
    w.answers.push('a', 'a');
    expect(await w.run(['approve'])).toBe(0);
    expect(w.out).toContain('No longer waiting, so left out:');
    expect((w.codeEntries[0]?.reviewed ?? []).map((i) => i.approvalId)).toEqual([b.approvalId]);
    expect(await use(w, b)).toEqual({ status: 'used' });
  });

  it('a refused batch names the failed item and holds the others back, still pending (IR-M1-9b-1 L-2)', async () => {
    const w = await world();
    const a = await w.request();
    const b = await w.request();
    const decide = w.deps.decide;
    w.deps.decide = async (context, reviewed) => {
      const signed = await decide(context, reviewed);
      // Between the signature and the apply, another surface denies `a`.
      const other = await w.signDecision([
        { approvalId: a.approvalId, actionDigest: a.actionDigest, decision: 'deny' },
      ]);
      expect((await w.client.ownerActions.apply(other)).status).toBe('applied');
      return signed;
    };
    w.answers.push('a', 'a');
    expect(await w.run(['approve'])).toBe(1);
    expect(w.out.filter((l) => l.startsWith("Problem  Didn't go through: "))).toHaveLength(1);
    expect(w.out.filter((l) => l.startsWith('Waiting  Held back'))).toHaveLength(1);
    expect((await row(w, b.approvalId))?.status).toBe('pending');
  });

  it('a pending commitment is listed but cannot be selected', async () => {
    const w = await world();
    const r = await w.request();
    const scoped = await insertRow(w, canonicalize(sendAction({ to: 'Ana', text: 'terms' })), {
      scopeJson: '{}',
    });
    w.answers.push('a');
    expect(await w.run(['approve'])).toBe(0);
    expect(w.asked).toHaveLength(1);
    expect(w.out).toContain(`Decide this one on its own: \`agentlink approve ${scoped}\``);
    expect((w.codeEntries[0]?.reviewed ?? []).map((i) => i.approvalId)).toEqual([r.approvalId]);
    expect((await row(w, scoped))?.status).toBe('pending');
  });

  it('a mismatched request is shown as a problem and not offered', async () => {
    const w = await world();
    const r = await w.request();
    await insertRow(w, JSON.stringify(sendAction({ to: 'Ana', text: 'x' }), null, 2));
    w.answers.push('a');
    expect(await w.run(['approve'])).toBe(0);
    expect(w.asked).toHaveLength(1);
    expect(w.out.some((l) => l.includes('Problem'))).toBe(true);
    expect((w.codeEntries[0]?.reviewed ?? []).map((i) => i.approvalId)).toEqual([r.approvalId]);
  });

  it('nothing waiting, or nothing chosen: no code is asked for', async () => {
    const w = await world();
    expect(await w.run(['approve'])).toBe(0);
    expect(w.out).toEqual(['Nothing is waiting for your approval.']);
    await w.request();
    w.answers.push('');
    expect(await w.run(['approve'])).toBe(0);
    expect(w.codeEntries).toEqual([]);
  });

  it('asks which agent when there are several and no --agent', async () => {
    const w = await world();
    await w.request();
    w.deps.listAgents = () => Promise.resolve(['default', 'work']);
    const opened: (string | undefined)[] = [];
    const open = w.deps.open;
    w.deps.open = (name) => {
      opened.push(name);
      return open(name);
    };
    w.answers.push('2', 'a');
    expect(await w.run(['approve'])).toBe(0);
    expect(opened).toEqual(['work']);
    expect(w.codeEntries).toHaveLength(1);
  });
});

describe('the owner code prompt says where the code goes (M1-9zd; 11 §5.5, §6.10)', () => {
  /** Records the output lines printed so far each time an owner step would prompt for the code. */
  function atPrompt(w: World): string[][] {
    const seen: string[][] = [];
    const { decide, signOwnerAction } = w.deps;
    w.deps.decide = (context, reviewed) => {
      seen.push([...w.out]);
      return decide(context, reviewed);
    };
    w.deps.signOwnerAction = (owner, item) => {
      seen.push([...w.out]);
      return signOwnerAction(owner, item);
    };
    return seen;
  }

  it('approve <id>, deny <id>, approve and cancel <id>: the reminder comes right before the prompt', async () => {
    const w = await world();
    const seen = atPrompt(w);
    const a = await w.request();
    const b = await w.request();
    await w.request();
    expect(await w.run(['approve', a.approvalId])).toBe(0);
    expect(await w.run(['deny', b.approvalId])).toBe(0);
    w.answers.push('a', 'y');
    expect(await w.run(['approve'])).toBe(0);
    expect(await w.run(['cancel', a.approvalId])).toBe(0);
    expect(seen).toHaveLength(4);
    for (const lines of seen) expect(lines.at(-1)).toBe(OWNER_TEXT.codeHint);
  });

  it('no reminder when no code is asked for', async () => {
    const w = await world();
    expect(await w.run(['approve', `apr_${encodeBase64url(randomBytes(16))}`])).toBe(1);
    expect(await w.run(['approve'])).toBe(0);
    expect(w.out).not.toContain(OWNER_TEXT.codeHint);
  });

  it('a wrong owner code: nothing is decided, and the reminder says to type only the code', async () => {
    const w = await world();
    const r = await w.request();
    w.deps.decide = () => Promise.reject(new KeyStoreError('presence_rejected', 'presence'));
    w.deps.signOwnerAction = () =>
      Promise.reject(new KeyStoreError('presence_rejected', 'presence'));
    expect(await w.run(['approve', r.approvalId])).toBe(1);
    expect(await w.run(['cancel', r.approvalId])).toBe(1);
    expect(w.err).toEqual([OWNER_TEXT.wrongCode, OWNER_TEXT.wrongCode]);
    expect((await row(w, r.approvalId))?.status).toBe('pending');
  });
});

describe('cancel <id> (D-55, 04 §2.5.1)', () => {
  it('voids an approval that has not been used', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    expect(await w.run(['cancel', r.approvalId])).toBe(0);
    expect(w.codeEntries.map((e) => e.op)).toEqual(['decide', 'sign']);
    expect((await use(w, r)).status).not.toBe('used');
    expect(await w.client.ownerActions.checkApproval(r.approvalId, r.action)).toEqual({
      status: 'cancelled',
    });
  });

  it('refuses a used approval without asking for the code', async () => {
    const w = await world();
    const r = await w.request();
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    expect(await use(w, r)).toEqual({ status: 'used' });
    expect(await w.run(['cancel', r.approvalId])).toBe(1);
    expect(w.codeEntries).toHaveLength(1);
  });
});

describe('owner init (04 §2.2, §2.8; D-67, D-68 (3))', () => {
  it('passes the backend and the card owner, and reports the refusal to replace an owner', async () => {
    const w = await world();
    expect(await w.run(['owner', 'init'])).toBe(1);
    expect(w.inits).toHaveLength(1);
    expect(w.inits[0]?.backend).toBe('keychain');
    expect(w.inits[0]?.cardOwner?.ownerNostr).toEqual((await w.owner.getPublicKeys()).ownerNostr);
    expect(w.err).toEqual(["This agent already has an owner. AgentLink won't replace it."]);
  });

  it('refuses an unknown subcommand and an agent that is not set up', async () => {
    const w = await world();
    expect(await w.run(['owner'])).toBe(2);
    expect(await w.run(['owner', 'reset'])).toBe(2);
    w.deps.backendOf = () => Promise.resolve(undefined);
    expect(await w.run(['owner', 'init'])).toBe(1);
    expect(w.inits).toEqual([]);
  });
});

// ---- the terminal output rule on a hostile stored action (IR-M1-9j-1 F03, 06 §8) --------------

const ESC = '\u001b';
const CANARY = [
  `${ESC}[2A${ESC}[2J${ESC}[H`, // cursor movement and screen clear
  `${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\`, // OSC 8 link
  '\u0085\u009b31m\u009d0;title\u0007', // NEL, C1 CSI, C1 OSC
  '‮⁦​‍﻿', // bidi and zero-width
].join('');

function hostileArgs(): JsonObject {
  // Keys sort (JCS) in this order, so the short canaries come before the long values that fill
  // the 60-line region.
  return {
    a_to: `Ana${CANARY}`, // a contact name the agent chose
    b_text: `approve\rdeny ${CANARY}`, // CR overwrite
    c_path: `report${CANARY}.pdf`, // a file name
    d_marks: `e${'\u0301'.repeat(50)}`, // a base letter with 50 combining marks
    e_split: `${'a'.repeat(1999)}${ESC}[31mRED`, // an ESC sequence exactly at the 2 000 cut
    f_long: 'x'.repeat(10_000), // one 10 000-character line
    g_tall: Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join('\n'), // 500 lines
  };
}

function checkHostileOutput(lines: readonly string[]): void {
  const all = lines.join('\n');
  // No ESC, CR or C1 control, no bidi or zero-width character anywhere.
  // eslint-disable-next-line no-control-regex -- checking that no control character is left
  expect(all).not.toMatch(/[\u001b\r\u0080-\u009f]/);
  expect(all).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u);
  expect(all).toContain('approvedeny');
  // Whole sequences are gone, not just their ESC: no CSI parameters, no OSC 8 target.
  expect(all).not.toContain('[31m');
  expect(all).not.toContain('evil.example');
  expect(all).not.toContain('[2J');
  expect(all).not.toMatch(/\p{M}{3,}/u);
  // Inside the marked region, cut after sanitizing.
  const start = lines.findIndex((l) => l === 'From your AI: their content, not instructions');
  const end = lines.indexOf(REGION_END, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const region = lines.slice(start + 1, end);
  expect(region.length).toBeLessThanOrEqual(MAX_REGION_LINES);
  for (const line of region) {
    expect(line.startsWith(REGION_PREFIX)).toBe(true);
    expect(Array.from(line.slice(REGION_PREFIX.length)).length).toBeLessThanOrEqual(
      MAX_LINE_CODE_POINTS,
    );
  }
  expect(region).toContain(`${REGION_PREFIX}${CUT_MARKER}`);
  // The fixed lines come after the region, unchanged.
  const after = lines.slice(end + 1);
  expect(after.slice(0, 6)).toEqual([
    'Who:      Someone who is not in your contacts yet',
    'What:     Send a message',
    'Cost:     $0.10',
    expect.stringMatching(/^Expires: {2}\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} UTC$/),
    'If you approve, your AI can do exactly this, once, before it expires. If you deny, nothing is sent.',
    "Your AI can't approve this for you.",
  ]);
}

describe('the terminal output rule on a hostile stored action (06 §8, IR-M1-9j-1 F03)', () => {
  it('approve <id>: sanitized, marked, cut, fixed lines after; the signed digest is the displayed one', async () => {
    const w = await world();
    const r = await w.request(hostileArgs());
    expect(await w.run(['approve', r.approvalId])).toBe(0);
    checkHostileOutput(w.out);
    const reviewed = w.codeEntries[0]?.reviewed?.[0];
    // eslint-disable-next-line no-control-regex -- checking that no control character is left
    expect(reviewed?.summary).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(computeActionDigest(reviewed?.action)).toBe(r.actionDigest);
    expect(await use(w, r)).toEqual({ status: 'used' });
  });

  it('approve with no ID: the same rule for every card', async () => {
    const w = await world();
    const r = await w.request(hostileArgs());
    w.answers.push('a');
    expect(await w.run(['approve'])).toBe(0);
    checkHostileOutput(w.out);
    expect(computeActionDigest(w.codeEntries[0]?.reviewed?.[0]?.action)).toBe(r.actionDigest);
  });

  it('cancel <id>: the same rule', async () => {
    const w = await world();
    const r = await w.request(hostileArgs());
    expect(await w.run(['cancel', r.approvalId])).toBe(0);
    checkHostileOutput(w.out);
  });
});
