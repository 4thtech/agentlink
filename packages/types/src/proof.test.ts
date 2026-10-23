// Proofs: the Record and Receipt JSON forms (05 §3.1), ProofPack v1 (07 §8) and ProofStatus
// (06 §2.4). Encodings per 04 §2.4.1; a verifier rejects a pack in any other form (07 §8).
import { describe, expect, it } from 'vitest';
import {
  approvalFeeSchema,
  approvalRequestBodySchema,
  commitmentAnswersSchema,
  commitmentScopeSchema,
  counterpartySchema,
  proofPackDisclosureSchema,
  proofPackReceiptSchema,
  proofPackRecipientSchema,
  proofPackSchema,
  proofPackSignerSchema,
  proofStatusSchema,
  recordSchema,
  receiptStructSchema,
  utcTimestampSchema,
} from './index.js';
import { expectAccept, expectReject, expectRoundTrip, type SafeParser } from './testing/assert.js';
import { ENCODING_VECTOR_CASES } from './testing/encoding-vectors.js';
import {
  AGENT_EVM,
  B32,
  BAD_USD_STRINGS,
  BIP340_SIG,
  CARD_AGENT_SIG,
  CARD_SIG,
  CONTACT_A,
  CONTACT_B,
  DELETE,
  ENVELOPE_HASH,
  FEE_TOKEN,
  KEY32,
  SHA,
  agentCard,
  approvalActions,
  approvalDecideAction,
  edit,
  hex,
  hex0x,
  minimalProofPack,
  policySetAction,
  proofPack,
  proofStatus,
  receiptStruct,
  record,
  signed,
} from './testing/fixtures.js';

type Path = (string | number)[];

describe('Record and Receipt JSON forms (05 §3.1)', () => {
  it('round-trip', () => {
    expectRoundTrip(recordSchema, record());
    expectRoundTrip(receiptStructSchema, receiptStruct());
    for (const kind of [1, 2, 3, 4, 5, 6]) expectRoundTrip(recordSchema, { ...record(), kind });
    for (const receiptType of [1, 2, 3, 4]) {
      expectRoundTrip(receiptStructSchema, { ...receiptStruct(), receiptType });
    }
  });

  it.each([
    ['kind 0', ['kind'], 0],
    ['kind 7', ['kind'], 7],
    ['kind as string', ['kind'], 'ACCEPT'],
    ['maxFee as a JSON number', ['maxFee'], 100000],
    ['maxFee with a leading zero', ['maxFee'], '0100000'],
    ['nonce in exponent form', ['nonce'], '1e3'],
    ['nonce above uint256', ['nonce'], (1n << 256n).toString()],
    ['deadline 2^53', ['deadline'], 2 ** 53],
    ['signer checksummed', ['signer'], AGENT_EVM.toUpperCase().replace('0X', '0x')],
    ['envelopeHash bare hex', ['envelopeHash'], ENVELOPE_HASH.slice(2)],
    ['appId of 31 bytes', ['appId'], hex0x(31, '00')],
    ['feeToken missing', ['feeToken'], DELETE],
    ['unknown key', ['chainId'], 8453],
  ] as [string, Path, unknown][])('Record rejects %s', (_l, path, value) => {
    expectReject(recordSchema, edit(record(), path, value));
  });

  it.each([
    ['receiptType 0', ['receiptType'], 0],
    ['receiptType 5', ['receiptType'], 5],
    ['salt bare hex', ['salt'], hex(32, '5b')],
    ['unknown key', ['at'], 1],
  ] as [string, Path, unknown][])('Receipt rejects %s', (_l, path, value) => {
    expectReject(receiptStructSchema, edit(receiptStruct(), path, value));
  });
});

describe('UTC timestamps (RFC 3339, YYYY-MM-DDTHH:MM:SSZ)', () => {
  it.each(['2026-10-14T12:00:00Z', '2024-02-29T23:59:59Z', '1970-01-01T00:00:00Z'])(
    'accepts %s',
    (t) => expectAccept(utcTimestampSchema, t),
  );

  it.each([
    '2026-10-14T12:00:00+02:00',
    '2026-10-14T12:00:00.000Z',
    '2026-10-14 12:00:00Z',
    '2026-10-14t12:00:00z',
    '2026-10-14T12:00Z',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-14T24:00:00Z',
    '2026-10-14T12:60:00Z',
    '2026-10-14T12:00:60Z',
    ' 2026-10-14T12:00:00Z',
    '1760000000',
    1760000000,
    '',
  ])('rejects %j', (t) => expectReject(utcTimestampSchema, t));
});

describe('ProofPack v1 (07 §8)', () => {
  it('the 07 §8 example pack (placeholders filled, every optional part present) parses', () => {
    expectRoundTrip(proofPackSchema, proofPack());
  });

  it('a minimal pack, and a pack with a standing-rule approval, parse', () => {
    expectRoundTrip(proofPackSchema, minimalProofPack());
    expectRoundTrip(proofPackSchema, {
      ...minimalProofPack(),
      ownerApproval: { standingRule: true, policyHash: SHA },
    });
    // Optional parts one at a time.
    expectRoundTrip(proofPackSchema, { ...minimalProofPack(), envelope: proofPack().envelope });
    expectRoundTrip(proofPackSchema, { ...minimalProofPack(), recipient: proofPack().recipient });
    expectRoundTrip(proofPackSchema, {
      ...minimalProofPack(),
      signer: { evm: AGENT_EVM, agentCard: agentCard(), cardSig: CARD_SIG },
    });
  });

  it('an ERC-1271 signature of another length is accepted (04 §2.4.1)', () => {
    expectRoundTrip(proofPackSchema, { ...proofPack(), signature: `0x${'a8'.repeat(96)}` });
  });

  it("a 65-byte ERC-1271 signature in a non-canonical form is accepted; the EOA check is the verifier's (04 §2.4.1)", () => {
    // As the Notary's SignatureChecker: such bytes never pass ECDSA recovery, only an account's
    // isValidSignature. @4thtech-io/chain verifyProofPack refuses them for an EOA signer.
    expectRoundTrip(proofPackSchema, {
      ...proofPack(),
      signature: `0x${'3c'.repeat(32)}${'ff'.repeat(32)}1b`,
    });
    expectRoundTrip(proofPackSchema, { ...proofPack(), signature: `0x${'3c'.repeat(64)}00` });
  });

  it.each([
    ['type', ['type'], 'agentlink.proof.v2'],
    ['version 2', ['version'], 2],
    ['chainId 0', ['chainId'], 0],
    ['chainId as string', ['chainId'], '8453'],
    ['notary uppercase', ['notary'], hex0x(20, '9A')],
    ['recordId bare hex', ['recordId'], B32.slice(2)],
    ['recordId as base64url', ['recordId'], KEY32],
    ['record with an unknown key', ['record', 'x'], 1],
    ['record kind 9', ['record', 'kind'], 9],
    ['signature with an odd number of hex digits', ['signature'], `${CARD_SIG}0`],
    ['signature 0x only', ['signature'], '0x'],
    ['signature uppercase', ['signature'], CARD_SIG.toUpperCase().replace('0X', '0x')],
    ['signer with an unknown key', ['signer', 'name'], 'Marko'],
    ['signer.evm not the record signer', ['signer', 'evm'], CONTACT_B],
    ['agentCard without cardSig', ['signer', 'cardSig'], DELETE],
    ['agentCard of another agent', ['signer', 'agentCard', 'agentEvm'], CONTACT_B],
    ['agentCard malformed', ['signer', 'agentCard', 'version'], 2],
    ['envelopeHash not the record envelopeHash', ['envelopeHash'], hex0x(32, 'e2')],
    ['envelopeHash bare hex', ['envelopeHash'], ENVELOPE_HASH.slice(2)],
    ['envelope malformed', ['envelope', 'v'], 2],
    ['envelope null (optional means absent)', ['envelope'], null],
    ['recipient with an unknown key', ['recipient', 'name'], 'x'],
    ['recipient salt bare hex', ['recipient', 'salt'], hex(32, '5b')],
    ['receipts not an array', ['receipts'], {}],
    ['receipt type lowercase', ['receipts', 0, 'type'], 'delivered'],
    ['receipt type unknown', ['receipts', 0, 'type'], 'SEEN'],
    ['receipt with an unknown key', ['receipts', 0, 'salt'], hex0x(32, '5b')],
    ['receipt txHash bare hex', ['receipts', 0, 'txHash'], hex(32, '7e')],
    ['receipt signer is not the disclosed recipient', ['receipts', 1, 'signer'], CONTACT_B],
    ['receipt at with an offset', ['receipts', 0, 'at'], '2026-10-14T14:00:00+02:00'],
    ['receipt at as unix seconds', ['receipts', 0, 'at'], 1760443200],
    ['disclosure missing (null is required when absent)', ['disclosure'], DELETE],
    ['contentKey of 31 bytes', ['disclosure', 'contentKey'], KEY32.slice(0, 42)],
    ['contentKey padded', ['disclosure', 'contentKey'], `${KEY32}=`],
    ['disclosure with an unknown key', ['disclosure', 'iv'], 'x'],
    ['ownerApproval missing', ['ownerApproval'], DELETE],
    ['ownerApproval with an unknown key', ['ownerApproval', 'note'], 'x'],
    [
      'ownerApproval signed deny',
      ['ownerApproval', 'signed', 'body', 'params', 'decision'],
      'deny',
    ],
    [
      'ownerApproval signed by another agent',
      ['ownerApproval', 'signed', 'body', 'agent'],
      CONTACT_B,
    ],
    ['ownerApproval sig uppercase', ['ownerApproval', 'signed', 'sig'], 'F6'.repeat(64)],
    [
      'ownerApproval action not a commitment',
      ['ownerApproval', 'action'],
      approvalActions().agentlink_send,
    ],
    ['ownerApproval action without scope', ['ownerApproval', 'action', 'context', 'scope'], DELETE],
    ['exportedAt as unix seconds', ['exportedAt'], 1760445000],
    ['exportedAt missing', ['exportedAt'], DELETE],
    ['unknown top-level key', ['note'], 'x'],
  ] as [string, Path, unknown][])('rejects %s', (_l, path, value) => {
    expectReject(proofPackSchema, edit(proofPack(), path, value));
  });

  describe('signer proof of possession: cardAgentSig and cardPop (M1-4d-d, D-102)', () => {
    const withPop = (over: Record<string, unknown> = {}) => ({
      ...proofPack(),
      signer: {
        evm: AGENT_EVM,
        agentCard: agentCard(),
        cardSig: CARD_SIG,
        cardAgentSig: CARD_AGENT_SIG,
        cardPop: BIP340_SIG,
        ...over,
      },
    });

    it('both signatures, together with the card, parse', () => {
      expectRoundTrip(proofPackSchema, withPop());
      expectRoundTrip(proofPackSchema, { ...minimalProofPack(), signer: withPop().signer });
    });

    it.each([
      ['cardAgentSig without cardPop', { cardPop: undefined }],
      ['cardPop without cardAgentSig', { cardAgentSig: undefined }],
      ['both without the card', { agentCard: undefined, cardSig: undefined }],
      ['cardPop with 0x', { cardPop: `0x${BIP340_SIG}` }],
      ['cardPop uppercase', { cardPop: BIP340_SIG.toUpperCase() }],
      ['cardPop of 63 bytes', { cardPop: BIP340_SIG.slice(2) }],
      ['cardPop of 65 bytes', { cardPop: `${BIP340_SIG}f6` }],
      ['cardAgentSig bare hex', { cardAgentSig: CARD_AGENT_SIG.slice(2) }],
      [
        'cardAgentSig uppercase',
        { cardAgentSig: CARD_AGENT_SIG.toUpperCase().replace('0X', '0x') },
      ],
      ['cardAgentSig of 64 bytes', { cardAgentSig: CARD_AGENT_SIG.slice(0, -2) }],
      ['cardAgentSig null', { cardAgentSig: null }],
    ] as [string, Record<string, unknown>][])('rejects %s', (_l, over) => {
      const pack = withPop(over);
      const signer = pack.signer as Record<string, unknown>;
      for (const key of Object.keys(signer)) if (signer[key] === undefined) delete signer[key];
      expectReject(proofPackSchema, pack);
      expectReject(proofPackSignerSchema, signer);
    });
  });

  it('rejects an owner approval that is another op or a bare action', () => {
    const p = proofPack();
    expectReject(proofPackSchema, {
      ...p,
      ownerApproval: { ...p.ownerApproval, signed: signed(policySetAction()) },
    });
    expectReject(proofPackSchema, {
      ...p,
      ownerApproval: { ...p.ownerApproval, signed: approvalDecideAction() },
    });
    expectReject(proofPackSchema, {
      ...p,
      ownerApproval: { standingRule: false, policyHash: SHA },
    });
    expectReject(proofPackSchema, {
      ...p,
      ownerApproval: { standingRule: true, policyHash: `0x${SHA}` },
    });
    expectReject(proofPackSchema, {
      ...p,
      ownerApproval: { standingRule: true, policyHash: SHA, signed: p.ownerApproval.signed },
    });
  });

  it('a content key is disclosed only together with the envelope it opens', () => {
    expectReject(proofPackSchema, { ...minimalProofPack(), disclosure: { contentKey: KEY32 } });
  });

  it('receipts: each type at most once, ACCEPTED and REJECTED exclusive, at most 4', () => {
    const r = (type: string) => ({
      type,
      signer: CONTACT_A,
      txHash: hex0x(32, '7e'),
      at: '2026-10-14T12:00:00Z',
    });
    const withReceipts = (receipts: unknown[]) => ({ ...proofPack(), receipts });
    expectAccept(proofPackSchema, withReceipts([r('DELIVERED'), r('OPENED'), r('ACCEPTED')]));
    expectReject(proofPackSchema, withReceipts([r('DELIVERED'), r('DELIVERED')]));
    expectReject(proofPackSchema, withReceipts([r('ACCEPTED'), r('REJECTED')]));
    expectReject(
      proofPackSchema,
      withReceipts([r('DELIVERED'), r('OPENED'), r('ACCEPTED'), r('REJECTED'), r('DELIVERED')]),
    );
  });

  it('the ownerApproval action is the same strict commitment action as in an approval-request', () => {
    const action = proofPack().ownerApproval.action;
    expectAccept(approvalRequestBodySchema, {
      approvalId: approvalDecideAction().params.approvalId,
      agent: AGENT_EVM,
      action,
      actionDigest: SHA,
      summary: 'Accept version 3',
      requestedAt: 1760000000,
      expiresAt: 1760086400,
    });
    expectAccept(commitmentScopeSchema, action.context.scope);
  });
});

/** A shallow copy of `o` without `keys`. */
function without<T extends object>(o: T, ...keys: string[]): Record<string, unknown> {
  const copy = { ...o } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy;
}

/** A fee before confirmation: the signed maxFee in base units and its USD value, no split yet. */
const quotedFee = () => ({ token: FEE_TOKEN, amount: '100000', usd: '0.1' });

describe('ProofStatus fee fields (06 §2.4, 07 §8 as merged in #30)', () => {
  const unconfirmed = (status: string, fee: unknown) => ({
    status,
    ...(status === 'submitted' ? { recordId: B32, txHash: hex0x(32, '7e') } : {}),
    fee,
    receipts: [],
  });

  it.each(['pending_approval', 'needs_credits', 'submitted', 'error'])(
    '%s: the fee is maxFee without a split',
    (status) => {
      expectRoundTrip(proofStatusSchema, unconfirmed(status, quotedFee()));
      // The split is the charged fee's, so it is never present before confirmation.
      expectReject(proofStatusSchema, unconfirmed(status, proofStatus().fee));
    },
  );

  it('ok: the split is optional (the core may not know it yet, M1-33d-d); both parts together', () => {
    expectRoundTrip(proofStatusSchema, proofStatus());
    expectRoundTrip(proofStatusSchema, { ...proofStatus(), fee: quotedFee() });
    expectReject(proofStatusSchema, edit(proofStatus(), ['fee', 'protocolUsd'], DELETE));
    expectReject(proofStatusSchema, edit(proofStatus(), ['fee', 'integratorUsd'], DELETE));
  });

  it('fee.token is an address (the zero address for a native stablecoin) and amount base units', () => {
    const zero = `0x${'00'.repeat(20)}`;
    expectRoundTrip(proofStatusSchema, edit(proofStatus(), ['fee', 'token'], zero));
    for (const token of ['USDC', 'xDAI', `0x${'AB'.repeat(20)}`, FEE_TOKEN.slice(2), null]) {
      expectReject(proofStatusSchema, edit(proofStatus(), ['fee', 'token'], token));
    }
    for (const amount of ['0.1', '1e5', '0100000', 100000]) {
      expectReject(proofStatusSchema, edit(proofStatus(), ['fee', 'amount'], amount));
    }
  });

  it('an approval context fee has no split (amount = the signed maxFee)', () => {
    expectAccept(approvalFeeSchema, quotedFee());
    expectReject(approvalFeeSchema, proofStatus().fee);
  });
});

describe('ProofStatus (06 §2.4)', () => {
  it('round-trips each status', () => {
    expectRoundTrip(proofStatusSchema, proofStatus());
    // Before confirmation the fee is the signed maxFee, with no protocol/integrator split (06 §2.4).
    const noRecord = {
      ...without(proofStatus(), 'recordId', 'txHash'),
      fee: quotedFee(),
    };
    expectRoundTrip(proofStatusSchema, { ...noRecord, status: 'pending_approval', receipts: [] });
    expectRoundTrip(proofStatusSchema, { ...noRecord, status: 'needs_credits', receipts: [] });
    expectRoundTrip(proofStatusSchema, { ...noRecord, status: 'error', receipts: [] });
    expectRoundTrip(proofStatusSchema, {
      ...noRecord,
      status: 'submitted',
      txHash: hex0x(32, '7e'),
      receipts: [],
    });
    // M1-33d-d: no chain at all (the CLI's default result names none, 06 §2.4 Advanced).
    expectRoundTrip(proofStatusSchema, { status: 'error', receipts: [] });
  });

  it('needs_credits carries agentAddress and an optional topUpUrl (06 §2.1, M1-33d-d)', () => {
    const credits = { status: 'needs_credits', receipts: [], agentAddress: AGENT_EVM };
    expectRoundTrip(proofStatusSchema, credits);
    expectRoundTrip(proofStatusSchema, {
      ...credits,
      topUpUrl: `https://pay.agentlink.4thtech.io/#v=1&a=${AGENT_EVM}&usd=5`,
    });
    expectReject(proofStatusSchema, {
      ...credits,
      agentAddress: AGENT_EVM.toUpperCase().replace('0X', '0x'),
    });
    expectReject(proofStatusSchema, { ...credits, topUpUrl: 'http://pay.example/' });
  });

  it('chain is never a top-level field: only advanced.chain (06 §2.4 Advanced, M1-33d-d)', () => {
    expectReject(proofStatusSchema, { ...proofStatus(), chain: 'base' });
    expectReject(proofStatusSchema, { status: 'error', chain: 'base', receipts: [] });
    expectRoundTrip(proofStatusSchema, without(proofStatus(), 'advanced'));
  });

  it.each([
    ['a status ProofStatus does not have', ['status'], 'rejected'],
    ['advanced chain with uppercase', ['advanced', 'chain'], 'Base'],
    ['advanced chain as chainId', ['advanced', 'chain'], 8453],
    ['recordId bare hex', ['recordId'], B32.slice(2)],
    ['txHash uppercase', ['txHash'], hex0x(32, '7E')],
    ['fee usd as a number', ['fee', 'usd'], 0.1],
    ['fee usd "0.10"', ['fee', 'usd'], '0.10'],
    ['fee protocolUsd "0.1" + integratorUsd "0.1" ≠ usd "0.1"', ['fee', 'integratorUsd'], '0.1'],
    ['fee with an unknown key', ['fee', 'chain'], 'base'],
    ['fee without integratorUsd', ['fee', 'integratorUsd'], DELETE],
    ['receipts missing', ['receipts'], DELETE],
    ['receipt with an unknown key', ['receipts', 0, 'signer'], CONTACT_A],
    ['receipt at not UTC', ['receipts', 0, 'at'], '2026-10-14T12:00:00+00:00'],
    // M1-33d-d: no explorer or verify link (the core returns none; 06 §2.4 proposed).
    ['explorerUrl', ['explorerUrl'], 'https://basescan.org/tx/1'],
    ['verifyUrl', ['verifyUrl'], 'https://verify.agentlink.example/r/1'],
    ['unknown key', ['signer'], AGENT_EVM],
    ['ok without a recordId', ['recordId'], DELETE],
    ['agentAddress on ok (needs_credits only)', ['agentAddress'], AGENT_EVM],
    ['topUpUrl on ok (needs_credits only)', ['topUpUrl'], 'https://pay.agentlink.4thtech.io/#v=1'],
  ] as [string, Path, unknown][])('rejects %s', (_l, path, value) => {
    expectReject(proofStatusSchema, edit(proofStatus(), path, value));
  });

  it.each(BAD_USD_STRINGS)(
    'rejects the fee amount %j in usd, protocolUsd and integratorUsd',
    (s) => {
      for (const key of ['usd', 'protocolUsd', 'integratorUsd']) {
        expectReject(proofStatusSchema, edit(proofStatus(), ['fee', key], s));
      }
    },
  );

  it('the fee total is exact: 0.1 + 0.2 = 0.3, and an app fee is shown separately', () => {
    const fee = (usd: string, protocolUsd: string, integratorUsd: string) =>
      edit(proofStatus(), ['fee'], { ...proofStatus().fee, usd, protocolUsd, integratorUsd });
    expectAccept(proofStatusSchema, fee('0.3', '0.1', '0.2'));
    expectAccept(proofStatusSchema, fee('0.5', '0.1', '0.4'));
    expectReject(proofStatusSchema, fee('0.30000000000000004', '0.1', '0.2'));
    expectReject(proofStatusSchema, fee('0.4', '0.1', '0.2'));
  });

  it('txHash is optional (06 §2.4, M1-33d-d); receipts need a record; receipts are unique', () => {
    expectRoundTrip(proofStatusSchema, without(proofStatus(), 'txHash'));
    expectRoundTrip(proofStatusSchema, {
      ...without(proofStatus(), 'txHash'),
      status: 'submitted',
      fee: quotedFee(),
    });
    expectReject(proofStatusSchema, {
      ...without(proofStatus(), 'recordId'),
      status: 'submitted',
      fee: quotedFee(),
    });
    expectReject(proofStatusSchema, {
      ...proofStatus(),
      receipts: [
        { type: 'ACCEPTED', at: '2026-10-14T12:00:00Z' },
        { type: 'REJECTED', at: '2026-10-14T12:01:00Z' },
      ],
    });
    expectReject(proofStatusSchema, {
      ...proofStatus(),
      receipts: [
        { type: 'DELIVERED', at: '2026-10-14T12:00:00Z' },
        { type: 'DELIVERED', at: '2026-10-14T12:01:00Z' },
      ],
    });
  });
});

describe('04 §2.4.1 encodings vectors (M1-1h) agree with the M1-2b path schemas', () => {
  const pack = proofPackSchema.shape;
  const scope = commitmentScopeSchema.shape;
  const request = approvalRequestBodySchema.shape;
  const rec = recordSchema.shape;
  const receipt = receiptStructSchema.shape;

  const PATHS: Record<string, SafeParser | undefined> = {
    'approval-request.agent': request.agent,
    'approval-request.actionDigest': request.actionDigest,
    'CommitmentScope.agentId': scope.agentId,
    'CommitmentScope.counterparty.agentId': counterpartySchema.shape.agentId,
    'CommitmentScope.counterparty.ownerKey': counterpartySchema.shape.ownerKey,
    'CommitmentScope.thread': scope.thread,
    'CommitmentScope.termsId': scope.termsId,
    'CommitmentScope.termsHash': scope.termsHash,
    'CommitmentScope.answers.envelopeId': commitmentAnswersSchema.shape.envelopeId,
    'CommitmentScope.answers.envelopeHash': commitmentAnswersSchema.shape.envelopeHash,
    'ProofPack.notary': pack.notary,
    'ProofPack.recordId': pack.recordId,
    'ProofPack.envelopeHash': pack.envelopeHash,
    'ProofPack.signature': pack.signature,
    'ProofPack.signer.evm': proofPackSignerSchema.shape.evm,
    'ProofPack.recipient.evm': proofPackRecipientSchema.shape.evm,
    'ProofPack.recipient.salt': proofPackRecipientSchema.shape.salt,
    'ProofPack.receipts[].signer': proofPackReceiptSchema.shape.signer,
    txHash: proofPackReceiptSchema.shape.txHash,
    'ProofPack.disclosure.contentKey': proofPackDisclosureSchema.shape.contentKey,
    'ProofPack.ownerApproval.policyHash': undefined, // checked through the whole pack below
    'ProofStatus.recordId': proofStatusSchema.shape.recordId,
    'ProofStatus.txHash': proofStatusSchema.shape.txHash,
    'Record.signer': rec.signer,
    'Record.envelopeHash': rec.envelopeHash,
    'Record.recipientCommitment': rec.recipientCommitment,
    'Record.parentRecordId': rec.parentRecordId,
    'Record.appId': rec.appId,
    'Record.feeToken': rec.feeToken,
    'Record.maxFee': rec.maxFee,
    'Record.nonce': rec.nonce,
    'Receipt.signer': receipt.signer,
    'Receipt.recordId': receipt.recordId,
    'Receipt.salt': receipt.salt,
  };
  // Paths with no field in an M1-2b schema: ProofStatus has no `signer` (06 §2.4), and the
  // agentlink_verify_proof_pack result is a tool-specific output (M1-9), not built here.
  const NOT_HERE = new Set([
    'ProofStatus.signer',
    'verify_proof_pack.recordId',
    'verify_proof_pack.envelopeHash',
  ]);

  it('every copied case maps to a schema or is listed as not built here', () => {
    expect(ENCODING_VECTOR_CASES.length).toBe(62);
    for (const c of ENCODING_VECTOR_CASES) {
      expect(c.path in PATHS || NOT_HERE.has(c.path), c.path).toBe(true);
    }
  });

  it.each(
    ENCODING_VECTOR_CASES.filter((c) => !NOT_HERE.has(c.path)).map((c) => [c.id, c] as const),
  )('%s', (_id, c) => {
    const leaf = PATHS[c.path];
    if (leaf !== undefined) {
      expect(leaf.safeParse(c.value).success, `${c.path} ${c.value}`).toBe(c.accept);
    }
    // The same value at its place in a whole object, where the path is a plain field.
    if (c.path === 'ProofPack.ownerApproval.policyHash') {
      const p = { ...proofPack(), ownerApproval: { standingRule: true, policyHash: c.value } };
      expect(proofPackSchema.safeParse(p).success).toBe(c.accept);
    }
    if (c.path === 'ProofPack.signature') {
      expect(proofPackSchema.safeParse({ ...proofPack(), signature: c.value }).success).toBe(
        c.accept,
      );
    }
    if (c.path.startsWith('Record.')) {
      const field = c.path.slice('Record.'.length);
      const r = { ...record(), [field]: c.value };
      expect(recordSchema.safeParse(r).success).toBe(c.accept);
    }
  });
});

describe('ProofStatus receipt and advanced fields (06 §2.4, D-109, M1-33d-c)', () => {
  const withField = (key: string, value: unknown) => ({ ...proofStatus(), [key]: value });

  it('accepts receiptRequested: true, receiptRequestNotAdded: true and advanced: {chain}', () => {
    expectRoundTrip(proofStatusSchema, withField('receiptRequested', true));
    expectRoundTrip(proofStatusSchema, withField('receiptRequestNotAdded', true));
    expectRoundTrip(proofStatusSchema, withField('advanced', { chain: 'base' }));
  });

  it('accepts all three together, and none of them (existing shape unchanged)', () => {
    expectRoundTrip(proofStatusSchema, {
      ...proofStatus(),
      receiptRequested: true,
      receiptRequestNotAdded: true,
      advanced: { chain: 'base' },
    });
    expectRoundTrip(proofStatusSchema, proofStatus());
  });

  it.each([
    ['receiptRequested false', 'receiptRequested', false],
    ['receiptRequested "true"', 'receiptRequested', 'true'],
    ['receiptRequestNotAdded false', 'receiptRequestNotAdded', false],
    ['receiptRequestNotAdded 1', 'receiptRequestNotAdded', 1],
    ['advanced as a string', 'advanced', 'base'],
    ['advanced without chain', 'advanced', {}],
    ['advanced chain uppercase', 'advanced', { chain: 'Base' }],
    ['advanced chain as chainId', 'advanced', { chain: 8453 }],
    ['advanced with an unknown key', 'advanced', { chain: 'base', token: '0x' }],
  ])('rejects %s', (_name, key, value) => {
    expectReject(proofStatusSchema, withField(key, value));
  });
});
