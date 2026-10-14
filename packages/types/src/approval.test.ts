// Approvals: CommitmentScope (04 §3.4.2), the per-tool `approval-request.action.context` (04 §3.4.1,
// M1-2b), the fee binding (04 §2.4.1 USD row) and the G-7 request TTL. Every context is built by the
// core; these schemas fix its exact shape so `actionDigest = sha256(JCS(action))` covers known facts.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TOOL_NAMES,
  APPROVAL_TTL_SECONDS,
  APPROVAL_TRIGGERS,
  MCP_TOOL_NAMES,
  approvalActionSchema,
  approvalFeeSchema,
  approvalRequestBodySchema,
  commitmentApprovalActionSchema,
  commitmentScopeSchema,
  payloadSchema,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip } from './testing/assert.js';
import {
  AGENT_EVM,
  BAD_USD_STRINGS,
  CONTACT_A,
  CONTACT_B,
  DELETE,
  ENVELOPE_HASH,
  FEE_TOKEN,
  ID16,
  SHA,
  approvalActions,
  approvalRequestFor,
  commitmentScope,
  edit,
  fee,
  firmOfferScope,
  payloads,
} from './testing/fixtures.js';

type Path = (string | number)[];

describe('CommitmentScope v1 (04 §3.4.2)', () => {
  it.each(['accept', 'reject', 'confirm'])('round-trips decision %s', (decision) => {
    expectRoundTrip(commitmentScopeSchema, { ...commitmentScope(), decision });
  });

  it('round-trips a firm offer (no answers) and a scope with nothing paid', () => {
    expectRoundTrip(commitmentScopeSchema, firmOfferScope());
    expectRoundTrip(commitmentScopeSchema, { ...commitmentScope(), maxFeeUsd: null });
    expectRoundTrip(commitmentScopeSchema, {
      ...commitmentScope(),
      notarize: false,
      maxFeeUsd: null,
    });
    // A scope may last exactly 7 days.
    expectRoundTrip(commitmentScopeSchema, {
      ...commitmentScope(),
      expiresAt: 1760000000 + 604_800,
    });
  });

  it.each([
    ['v 2', ['v'], 2],
    ['another kind', ['kind'], 'agentlink/commitment/v2'],
    ['unknown decision', ['decision'], 'counter'],
    ['unknown key', ['note'], 'x'],
    ['unknown counterparty key', ['counterparty', 'name'], 'Marko'],
    ['unknown answers key', ['answers', 'x'], 1],
    ['uppercase agentId', ['agentId'], AGENT_EVM.toUpperCase()],
    ['agentId without 0x', ['agentId'], AGENT_EVM.slice(2)],
    [
      'counterparty agentId checksummed',
      ['counterparty', 'agentId'],
      '0x3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d3D3d',
    ],
    [
      'ownerKey with 0x (it is a Nostr key, bare hex)',
      ['counterparty', 'ownerKey'],
      `0x${'c4'.repeat(32)}`,
    ],
    ['ownerKey of 31 bytes', ['counterparty', 'ownerKey'], 'c4'.repeat(31)],
    ['thread as hex', ['thread'], 'ab'.repeat(16)],
    ['termsId of 15 bytes', ['termsId'], ID16.slice(0, 20)],
    ['version 0', ['version'], 0],
    ['version as string', ['version'], '3'],
    ['termsHash with 0x', ['termsHash'], `0x${SHA}`],
    [
      'answers.envelopeHash bare hex (EVM-native, needs 0x)',
      ['answers', 'envelopeHash'],
      ENVELOPE_HASH.slice(2),
    ],
    ['answers.envelopeId as hex', ['answers', 'envelopeId'], 'ab'.repeat(16)],
    ['answers missing on an accept', ['answers'], null],
    ['notarize as string', ['notarize'], 'true'],
    ['maxFeeUsd as a JSON number', ['maxFeeUsd'], 0.1],
    ['maxFeeUsd "0.10"', ['maxFeeUsd'], '0.10'],
    ['createdAt as string', ['createdAt'], '1760000000'],
    ['expiresAt equal to createdAt', ['expiresAt'], 1760000000],
    ['expiresAt before createdAt', ['expiresAt'], 1759999999],
    ['expiresAt beyond createdAt + 7 days', ['expiresAt'], 1760000000 + 604_801],
    ['missing expiresAt', ['expiresAt'], DELETE],
    ['counterparty is the agent itself', ['counterparty', 'agentId'], AGENT_EVM],
  ] as [string, Path, unknown][])('rejects %s', (_l, path, value) => {
    expectReject(commitmentScopeSchema, edit(commitmentScope(), path, value));
  });

  it.each(BAD_USD_STRINGS)('rejects maxFeeUsd %j', (s) => {
    expectReject(commitmentScopeSchema, { ...commitmentScope(), maxFeeUsd: s });
  });

  it('a firm offer has no answers and is always notarized; other decisions answer an envelope', () => {
    expectReject(commitmentScopeSchema, {
      ...firmOfferScope(),
      answers: commitmentScope().answers,
    });
    expectReject(commitmentScopeSchema, { ...firmOfferScope(), notarize: false, maxFeeUsd: null });
    for (const decision of ['accept', 'reject', 'confirm']) {
      expectReject(commitmentScopeSchema, { ...commitmentScope(), decision, answers: null });
    }
  });

  it('nothing is paid without notarize: notarize false requires maxFeeUsd null', () => {
    expectReject(commitmentScopeSchema, { ...commitmentScope(), notarize: false });
  });
});

describe('approval fee binding {token, amount, usd} (04 §3.4.1, §2.4.1)', () => {
  it('round-trips', () => expectRoundTrip(approvalFeeSchema, fee()));

  it.each([
    ['usd as a JSON number', ['usd'], 0.1],
    ['usd "0.10"', ['usd'], '0.10'],
    ['amount with a leading zero', ['amount'], '0100000'],
    ['amount as a JSON number', ['amount'], 100000],
    ['amount with a fraction', ['amount'], '0.1'],
    ['token checksummed', ['token'], FEE_TOKEN.toUpperCase()],
    ['token as a symbol', ['token'], 'USDC'],
    ['unknown key', ['chain'], 'base'],
    ['missing usd', ['usd'], DELETE],
  ] as [string, Path, unknown][])('rejects %s', (_l, path, value) => {
    expectReject(approvalFeeSchema, edit(fee(), path, value));
  });
});

describe('approval-request action: one strict context per tool (04 §3.4.1, M1-2b)', () => {
  const actions = Object.entries(approvalActions());

  it('covers exactly the tools of the 06 §2.0 "Approval" column', () => {
    expect(actions.map(([tool]) => tool).sort()).toEqual([...APPROVAL_TOOL_NAMES].sort());
  });

  it.each(actions)('%s round-trips, alone and inside an approval-request', (_tool, action) => {
    expectRoundTrip(approvalActionSchema, action);
    const expiresAt =
      'scope' in action.context
        ? Math.min(1760000000 + APPROVAL_TTL_SECONDS, action.context.scope.expiresAt)
        : 1760000000 + APPROVAL_TTL_SECONDS;
    expectRoundTrip(approvalRequestBodySchema, approvalRequestFor(action, expiresAt));
  });

  it.each(actions)('%s rejects an unknown or missing context key', (_tool, action) => {
    expectReject(approvalActionSchema, edit(action, ['context', 'extra'], 1));
    for (const key of Object.keys(action.context)) {
      expectReject(approvalActionSchema, edit(action, ['context', key], DELETE));
    }
  });

  it.each(actions)('%s rejects the context of every other tool', (tool, action) => {
    for (const [other, otherAction] of actions) {
      if (other === tool) continue;
      expectReject(approvalActionSchema, { ...action, context: otherAction.context });
    }
  });

  it.each(actions)('%s rejects empty, unsorted, duplicate or foreign triggers', (_tool, action) => {
    const triggers = action.context.triggers;
    expectReject(approvalActionSchema, edit(action, ['context', 'triggers'], []));
    expectReject(
      approvalActionSchema,
      edit(action, ['context', 'triggers'], [...triggers, triggers[0]]),
    );
    if (triggers.length > 1) {
      expectReject(
        approvalActionSchema,
        edit(action, ['context', 'triggers'], [...triggers].reverse()),
      );
    }
    expectReject(approvalActionSchema, edit(action, ['context', 'triggers'], ['policy.set']));
    expectReject(approvalActionSchema, edit(action, ['context', 'triggers'], 'proofs.notarize'));
  });

  it('allows only the policy rules that can gate each tool (06 §2.0, §3)', () => {
    const a = approvalActions();
    const withTriggers = (action: object, triggers: string[]) =>
      edit(action, ['context', 'triggers'], triggers);
    // accept_invite: only contacts.acceptInvites.
    expectReject(
      approvalActionSchema,
      withTriggers(a.agentlink_accept_invite, ['proofs.notarize']),
    );
    // send and notarize: only the proof rules.
    for (const action of [a.agentlink_send, a.agentlink_notarize]) {
      expectAccept(
        approvalActionSchema,
        withTriggers(action, [
          'proofs.dailyBudgetUSD',
          'proofs.notarize',
          'proofs.perActionMaxUSD',
        ]),
      );
      expectReject(approvalActionSchema, withTriggers(action, ['commitments.accept']));
      expectReject(approvalActionSchema, withTriggers(action, ['proofs.allowKeyDisclosure']));
    }
    // terms tools: commitments.accept and the proof rules.
    expectAccept(
      approvalActionSchema,
      withTriggers(a.agentlink_respond_to_terms, ['commitments.accept', 'proofs.dailyBudgetUSD']),
    );
    expectReject(
      approvalActionSchema,
      withTriggers(a.agentlink_respond_to_terms, ['contacts.acceptInvites']),
    );
    // acknowledge: commitments.accept only; export: allowKeyDisclosure only.
    expectReject(approvalActionSchema, withTriggers(a.agentlink_acknowledge, ['proofs.notarize']));
    expectReject(
      approvalActionSchema,
      withTriggers(a.agentlink_export_proof_pack, ['commitments.accept']),
    );
    expect([...APPROVAL_TRIGGERS].sort()).toEqual([
      'commitments.accept',
      'contacts.acceptInvites',
      'proofs.allowKeyDisclosure',
      'proofs.dailyBudgetUSD',
      'proofs.notarize',
      'proofs.perActionMaxUSD',
    ]);
  });

  it.each([
    [
      'send: file hash with 0x',
      'agentlink_send',
      ['context', 'file', 'plaintextSha256'],
      `0x${SHA}`,
    ],
    ['send: file size as string', 'agentlink_send', ['context', 'file', 'size'], '1000'],
    ['send: unknown file key', 'agentlink_send', ['context', 'file', 'name'], 'contract.pdf'],
    ['send: no fee on a proof approval', 'agentlink_send', ['context', 'fee'], null],
    ['send: counterparty null', 'agentlink_send', ['context', 'counterparty'], null],
    [
      'accept_invite: inviteId as hex',
      'agentlink_accept_invite',
      ['context', 'inviteId'],
      'ab'.repeat(16),
    ],
    [
      'notarize: envelopeHash bare hex',
      'agentlink_notarize',
      ['context', 'envelopeHash'],
      ENVELOPE_HASH.slice(2),
    ],
    ['notarize: no fee', 'agentlink_notarize', ['context', 'fee'], null],
    [
      'acknowledge: DELIVERED is automatic, never approved',
      'agentlink_acknowledge',
      ['context', 'receipt'],
      'DELIVERED',
    ],
    [
      'acknowledge: OPENED needs no approval',
      'agentlink_acknowledge',
      ['context', 'receipt'],
      'OPENED',
    ],
    ['acknowledge: recordId bare hex', 'agentlink_acknowledge', ['context', 'recordId'], SHA],
    ['export: recordId bare hex', 'agentlink_export_proof_pack', ['context', 'recordId'], SHA],
    [
      'propose_terms: a scope that is not a firm offer',
      'agentlink_propose_terms',
      ['context', 'scope'],
      commitmentScope(),
    ],
    [
      'respond_to_terms: a firm offer scope',
      'agentlink_respond_to_terms',
      ['context', 'scope'],
      firmOfferScope(),
    ],
    [
      'respond_to_terms: terms not an object',
      'agentlink_respond_to_terms',
      ['context', 'terms'],
      'the terms',
    ],
    [
      'respond_to_terms: fee null while maxFeeUsd is set',
      'agentlink_respond_to_terms',
      ['context', 'fee'],
      null,
    ],
    [
      'respond_to_terms: fee above maxFeeUsd',
      'agentlink_respond_to_terms',
      ['context', 'fee', 'usd'],
      '0.100001',
    ],
    [
      'respond_to_terms: fee usd "0.10"',
      'agentlink_respond_to_terms',
      ['context', 'fee', 'usd'],
      '0.10',
    ],
    [
      'respond_to_terms: fee usd as a number',
      'agentlink_respond_to_terms',
      ['context', 'fee', 'usd'],
      0.1,
    ],
    [
      'respond_to_terms: unknown scope key',
      'agentlink_respond_to_terms',
      ['context', 'scope', 'x'],
      1,
    ],
  ] as [string, keyof ReturnType<typeof approvalActions>, Path, unknown][])(
    'rejects %s',
    (_l, tool, path, value) => {
      expectReject(approvalActionSchema, edit(approvalActions()[tool], path, value));
    },
  );

  it('commitment fees: a fee needs maxFeeUsd; a proof trigger needs a fee; fee ≤ maxFeeUsd', () => {
    const r = approvalActions().agentlink_respond_to_terms;
    const noFee = edit(edit(r, ['context', 'fee'], null), ['context', 'scope', 'maxFeeUsd'], null);
    expectAccept(approvalActionSchema, noFee);
    // A fee without a scope cap.
    expectReject(approvalActionSchema, edit(r, ['context', 'scope', 'maxFeeUsd'], null));
    // A proof trigger without a fee.
    expectReject(
      approvalActionSchema,
      edit(noFee, ['context', 'triggers'], ['commitments.accept', 'proofs.notarize']),
    );
    // Exactly at the cap is fine, a cheaper quote too.
    expectAccept(approvalActionSchema, edit(r, ['context', 'fee', 'usd'], '0.1'));
    expectAccept(approvalActionSchema, edit(r, ['context', 'fee', 'usd'], '0.05'));
  });

  it('notarize: a self-note has no counterparty', () => {
    expectAccept(
      approvalActionSchema,
      edit(approvalActions().agentlink_notarize, ['context', 'counterparty'], null),
    );
  });

  it('send: a message without a file binds file null', () => {
    expectAccept(
      approvalActionSchema,
      edit(approvalActions().agentlink_send, ['context', 'file'], null),
    );
  });

  it('commitmentApprovalActionSchema accepts only the terms tools', () => {
    const a = approvalActions();
    expectRoundTrip(commitmentApprovalActionSchema, a.agentlink_respond_to_terms);
    expectRoundTrip(commitmentApprovalActionSchema, a.agentlink_propose_terms);
    for (const action of [a.agentlink_send, a.agentlink_acknowledge, a.agentlink_notarize]) {
      expectReject(commitmentApprovalActionSchema, action);
    }
  });
});

describe('approval-request body: TTL and binding (04 §3.4.1, G-7)', () => {
  const send = () => approvalActions().agentlink_send;
  const respond = () => approvalActions().agentlink_respond_to_terms;

  it('a request expires exactly 24 h after it was made', () => {
    expect(APPROVAL_TTL_SECONDS).toBe(86_400);
    expectAccept(approvalRequestBodySchema, approvalRequestFor(send(), 1760000000 + 86_400));
    expectReject(approvalRequestBodySchema, approvalRequestFor(send(), 1760000000 + 86_399));
    expectReject(approvalRequestBodySchema, approvalRequestFor(send(), 1760000000 + 86_401));
  });

  it('a commitment request expires at min(requestedAt + 24 h, scope.expiresAt)', () => {
    // Scope outlives the TTL: the TTL wins.
    expectAccept(approvalRequestBodySchema, approvalRequestFor(respond(), 1760086400));
    expectReject(approvalRequestBodySchema, approvalRequestFor(respond(), 1760600000));
    // Scope ends sooner: the request ends with it.
    const short = edit(respond(), ['context', 'scope', 'expiresAt'], 1760050000);
    expectAccept(approvalRequestBodySchema, approvalRequestFor(short, 1760050000));
    expectReject(approvalRequestBodySchema, approvalRequestFor(short, 1760086400));
  });

  it('a commitment scope belongs to the requesting agent', () => {
    const other = edit(respond(), ['context', 'scope', 'agentId'], CONTACT_B);
    expectReject(approvalRequestBodySchema, approvalRequestFor(other));
    expectReject(approvalRequestBodySchema, { ...approvalRequestFor(respond()), agent: CONTACT_B });
  });

  it('the payload fixture carries a strict send context', () => {
    expectRoundTrip(payloadSchema, payloads()['approval-request']);
    expectReject(
      payloadSchema,
      edit(payloads()['approval-request'], ['body', 'action', 'context'], {
        contactEvm: CONTACT_A,
      }),
    );
  });
});

describe('I-4: no type lets an MCP tool change policy or decide an approval', () => {
  it('no approval-request tool is an owner operation, and get_approval only reads', () => {
    for (const tool of MCP_TOOL_NAMES) {
      expect(tool).not.toMatch(/polic|decide|approve|cancel|revoke|grant/);
    }
    expect(APPROVAL_TOOL_NAMES).not.toContain('agentlink_get_approval');
  });

  it('an action context cannot carry a decision, a signature or a policy', () => {
    for (const [, action] of Object.entries(approvalActions())) {
      for (const key of ['decision', 'signed', 'sig', 'policy', 'approved']) {
        expectReject(approvalActionSchema, edit(action, ['context', key], 'approve'));
      }
    }
  });

  it('commitment scopes stay inside the core: args never replace the scope', () => {
    // The scope is in context, never in args; a scope smuggled into args stays free JSON there and
    // never satisfies the context requirement.
    const r = approvalActions().agentlink_respond_to_terms;
    const moved = edit(edit(r, ['args', 'scope'], r.context.scope), ['context', 'scope'], DELETE);
    expectReject(approvalActionSchema, moved);
    expect(r.args).not.toHaveProperty('scope');
  });
});
