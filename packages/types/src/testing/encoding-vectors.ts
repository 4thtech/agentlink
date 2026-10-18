// Test data for @4thtech-io/types. Not part of the build (tsconfig.json excludes src/testing).
//
// A verbatim copy of the M1-1h `decode` cases from test-vectors/encodings/vectors.json whose
// path belongs to an M1-2b schema (Record, Receipt, ProofPack, ProofStatus, CommitmentScope,
// approval-request, txHash). It is copied because the package boundary rule forbids a relative
// import that leaves the package. Each case keeps its id, so a drift is easy to diff.
// Source suite: encodings version 1; 62 cases.

export interface EncodingVectorCase {
  readonly id: string;
  readonly path: string;
  readonly value: string;
  readonly accept: boolean;
}

export const ENCODING_VECTOR_CASES: readonly EncodingVectorCase[] = [
  {
    id: 'decode-approval-request-agent',
    path: 'approval-request.agent',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-agent-id',
    path: 'CommitmentScope.agentId',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-counterparty-agent-id',
    path: 'CommitmentScope.counterparty.agentId',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-pack-notary',
    path: 'ProofPack.notary',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-pack-signer-evm',
    path: 'ProofPack.signer.evm',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-pack-recipient-evm',
    path: 'ProofPack.recipient.evm',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-pack-receipts-signer',
    path: 'ProofPack.receipts[].signer',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-record-signer',
    path: 'Record.signer',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-receipt-signer',
    path: 'Receipt.signer',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-record-fee-token',
    path: 'Record.feeToken',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-status-signer',
    path: 'ProofStatus.signer',
    value: '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876',
    accept: true,
  },
  {
    id: 'decode-proof-pack-record-id',
    path: 'ProofPack.recordId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-proof-pack-recipient-salt',
    path: 'ProofPack.recipient.salt',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-answers-envelope-hash',
    path: 'CommitmentScope.answers.envelopeHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-proof-pack-envelope-hash',
    path: 'ProofPack.envelopeHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-record-envelope-hash',
    path: 'Record.envelopeHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-record-recipient-commitment',
    path: 'Record.recipientCommitment',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-record-parent-record-id',
    path: 'Record.parentRecordId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-record-app-id',
    path: 'Record.appId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-receipt-record-id',
    path: 'Receipt.recordId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-receipt-salt',
    path: 'Receipt.salt',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-tx-hash',
    path: 'txHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-proof-status-record-id',
    path: 'ProofStatus.recordId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-proof-status-tx-hash',
    path: 'ProofStatus.txHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-verify-proof-pack-record-id',
    path: 'verify_proof_pack.recordId',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-verify-proof-pack-envelope-hash',
    path: 'verify_proof_pack.envelopeHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8',
    accept: true,
  },
  {
    id: 'decode-proof-pack-signature',
    path: 'ProofPack.signature',
    value:
      '0x7f06ad46921912a062ae94ea3729d7936eced9807ee1b28288f1e72b77ac25d14fc12dfcf299a952d39a189af23bbc2587e15b62c7f184f476a3277249fa639c1b',
    accept: true,
  },
  {
    id: 'decode-record-max-fee',
    path: 'Record.maxFee',
    value: '1500000',
    accept: true,
  },
  {
    id: 'decode-record-nonce',
    path: 'Record.nonce',
    value: '1500000',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-counterparty-owner-key',
    path: 'CommitmentScope.counterparty.ownerKey',
    value: 'cfca2d0d611cbfc149a2002ffa5056f9ff133238f5a4a47aa0ac910a443682eb',
    accept: true,
  },
  {
    id: 'decode-approval-request-action-digest',
    path: 'approval-request.actionDigest',
    value: '9fd764ebb50143ecfb8d732f75864134131ec98df6e872e56fef45331bfda6d9',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-terms-hash',
    path: 'CommitmentScope.termsHash',
    value: '9fd764ebb50143ecfb8d732f75864134131ec98df6e872e56fef45331bfda6d9',
    accept: true,
  },
  {
    id: 'decode-proof-pack-owner-approval-policy-hash',
    path: 'ProofPack.ownerApproval.policyHash',
    value: '9fd764ebb50143ecfb8d732f75864134131ec98df6e872e56fef45331bfda6d9',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-answers-envelope-id',
    path: 'CommitmentScope.answers.envelopeId',
    value: 's0yUSQhCoovfU99ZfHh9uA',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-thread',
    path: 'CommitmentScope.thread',
    value: 'nXD3xRvbEHB06D2HsxMfLw',
    accept: true,
  },
  {
    id: 'decode-commitment-scope-terms-id',
    path: 'CommitmentScope.termsId',
    value: 'yAWyU2IRoCWDu44BuMAnZw',
    accept: true,
  },
  {
    id: 'decode-proof-pack-disclosure-content-key',
    path: 'ProofPack.disclosure.contentKey',
    value: 'Vp02v1h0TN-5wvo2qf5IqURg_IpoPRyP_PDxOZ1vOZc',
    accept: true,
  },
  {
    id: 'reject-length-commitment-scope-answers-envelope-id-short',
    path: 'CommitmentScope.answers.envelopeId',
    value: 's0yUSQhCoovfU99ZfHh9',
    accept: false,
  },
  {
    id: 'reject-length-commitment-scope-answers-envelope-id-long',
    path: 'CommitmentScope.answers.envelopeId',
    value: 's0yUSQhCoovfU99ZfHh9uFs',
    accept: false,
  },
  {
    id: 'reject-length-commitment-scope-thread-short',
    path: 'CommitmentScope.thread',
    value: 'nXD3xRvbEHB06D2HsxMf',
    accept: false,
  },
  {
    id: 'reject-length-commitment-scope-thread-long',
    path: 'CommitmentScope.thread',
    value: 'nXD3xRvbEHB06D2HsxMfL5s',
    accept: false,
  },
  {
    id: 'reject-length-commitment-scope-terms-id-short',
    path: 'CommitmentScope.termsId',
    value: 'yAWyU2IRoCWDu44BuMAn',
    accept: false,
  },
  {
    id: 'reject-length-commitment-scope-terms-id-long',
    path: 'CommitmentScope.termsId',
    value: 'yAWyU2IRoCWDu44BuMAnZxs',
    accept: false,
  },
  {
    id: 'reject-length-proof-pack-disclosure-content-key-short',
    path: 'ProofPack.disclosure.contentKey',
    value: 'Vp02v1h0TN-5wvo2qf5IqURg_IpoPRyP_PDxOZ1vOQ',
    accept: false,
  },
  {
    id: 'reject-length-proof-pack-disclosure-content-key-long',
    path: 'ProofPack.disclosure.contentKey',
    value: 'Vp02v1h0TN-5wvo2qf5IqURg_IpoPRyP_PDxOZ1vOZcU',
    accept: false,
  },
  {
    id: 'reject-bytes32-uppercase',
    path: 'Record.envelopeHash',
    value: '0xB7E140215F66966B2B7E24383B62A0D3C561024C091438266970A33D4AC366B8',
    accept: false,
  },
  {
    id: 'reject-bytes32-trailing-space',
    path: 'txHash',
    value: '0xb7e140215f66966b2b7e24383b62a0d3c561024c091438266970a33d4ac366b8 ',
    accept: false,
  },
  {
    id: 'decode-proof-pack-signature-erc1271',
    path: 'ProofPack.signature',
    value:
      '0xa8659bfd6c0fee5861883c8a53dce9786626de892943c3c507a521122f14aadba8659bfd6c0fee5861883c8a53dce9786626de892943c3c507a521122f14aadba8659bfd6c0fee5861883c8a53dce9786626de892943c3c507a521122f14aadb',
    accept: true,
  },
  {
    id: 'reject-proof-pack-signature-odd-hex',
    path: 'ProofPack.signature',
    value:
      '0x7f06ad46921912a062ae94ea3729d7936eced9807ee1b28288f1e72b77ac25d14fc12dfcf299a952d39a189af23bbc2587e15b62c7f184f476a3277249fa639c1',
    accept: false,
  },
  {
    id: 'reject-proof-pack-signature-empty',
    path: 'ProofPack.signature',
    value: '0x',
    accept: false,
  },
  {
    id: 'reject-proof-pack-signature-high-s',
    path: 'ProofPack.signature',
    value:
      '0x7f06ad46921912a062ae94ea3729d7936eced9807ee1b28288f1e72b77ac25d1b03ed2030d6656ad2c65e7650dc443d932cd8183e7571b47492f371a863bdda51c',
    accept: false,
  },
  {
    id: 'decode-uint256-zero',
    path: 'Record.maxFee',
    value: '0',
    accept: true,
  },
  {
    id: 'decode-uint256-max',
    path: 'Record.maxFee',
    value: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    accept: true,
  },
  {
    id: 'reject-uint256-leading-zero',
    path: 'Record.nonce',
    value: '01500',
    accept: false,
  },
  {
    id: 'reject-uint256-plus',
    path: 'Record.nonce',
    value: '+1500',
    accept: false,
  },
  {
    id: 'reject-uint256-minus',
    path: 'Record.nonce',
    value: '-1',
    accept: false,
  },
  {
    id: 'reject-uint256-overflow',
    path: 'Record.nonce',
    value: '115792089237316195423570985008687907853269984665640564039457584007913129639936',
    accept: false,
  },
  {
    id: 'reject-uint256-fraction',
    path: 'Record.nonce',
    value: '1500.0',
    accept: false,
  },
  {
    id: 'reject-uint256-exponent',
    path: 'Record.nonce',
    value: '1e3',
    accept: false,
  },
  {
    id: 'reject-uint256-hex',
    path: 'Record.nonce',
    value: '0x5dc',
    accept: false,
  },
  {
    id: 'reject-uint256-whitespace',
    path: 'Record.nonce',
    value: '1500 ',
    accept: false,
  },
  {
    id: 'reject-uint256-empty',
    path: 'Record.nonce',
    value: '',
    accept: false,
  },
];
