// M1-4a: Record, Receipt and AgentCard builders (07 §6.2; 05 §3.1; 04 §2.4, §5; D-61, D-86).
//
// Parity: the expected values are verbatim copies from test-vectors/eip712-proof/vectors.json and
// test-vectors/eip712/vectors.json, cited by case ID (this package may not read files outside
// itself, deps-check). The hashing is @4thtech-io/crypto's, which the vector harness checks in every
// runtime; these tests pin that the builders put exactly the vector's fields under exactly the
// vector's domain.
import {
  encodeHex0x,
  hashTypedData,
  recipientCommitment,
  type TypedData,
} from '@4thtech-io/crypto';
import { describe, expect, it, vi } from 'vitest';
import { assembleRecord } from './builders.js';
import * as typedDataModule from './index.js';
import {
  RECEIPT_TYPE,
  RECORD_KIND,
  agentCardTypedData,
  buildReceipt,
  buildRecord,
  signAgentCard,
  signReceipt,
  signRecord,
  type RecordInput,
} from './index.js';

const ZERO32 = `0x${'0'.repeat(64)}`;
const hex = (b: Uint8Array): string => encodeHex0x(b);

// --- vector copies -----------------------------------------------------------------------------

/** record-message: kind 1 MESSAGE to the recipient of commitment-basic, Base Sepolia domain. */
const RECORD_MESSAGE = {
  chainId: 84532,
  notary: '0x252d9a9c22652a8c08b12eda14d30906850542c9',
  recipient: '0xe09a6724ce75ed0badc4bb6a5ecf4f28e75ee558',
  salt: '0xb529be83d68c21c739ecccae31d44b853b51551a9c436f57bbc617da4a287731', // commitment-basic
  record: {
    signer: '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a',
    envelopeHash: '0x38febeb3650a8e5d354bfa5493835b16012673181c3e1755aaf8b234d053ed88',
    recipientCommitment: '0xdf8769780934da646f92597340ae4efeb1a0702cba1e49b07dfd97eaab78860b',
    parentRecordId: ZERO32,
    appId: ZERO32,
    kind: 1,
    feeToken: '0x05f7cddba6070777972ad9ff9df5312872a49685',
    maxFee: '250000',
    nonce: '53413080818580974331135570314775698628850412394171742376625802275545193048131',
    deadline: 1760003600,
  },
  digest: '0x62cf8d22185e1ce6d534993e24e3e41c2f34eb7f5dc38649d153627cfe8a8802',
  structHash: '0xb48f916acb552ca670a5a112006956be55a9b28db6fd364a2705963783c6e3b5',
  domainSeparator: '0xc5821c8e3a7d8f3abc373965163288a80469d2b48c201393faf66694949d0362',
  recordId: '0xe24e95611787c13ff990f930ae7f5e4fd5aabbbc6c493929691180d708efe1a6', // receipt-delivered
} as const;

/** record-message-chiado: the same Record under chain 10200. */
const RECORD_MESSAGE_CHIADO_DIGEST =
  '0x00c54f43943035cd50f42bd1e97176e73fff498933c960eae2c512ae3bf3552e';

/** record-reply-file: kind 2 FILE reply, commitment-other-salt, appId, native fee token. */
const RECORD_REPLY_FILE = {
  salt: '0x0d87efa81dcf23b3d5ea2682f941d412824a58d27ec16b57ddf23abd92439a98', // commitment-other-salt
  record: {
    signer: '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a',
    envelopeHash: '0xbb1e0b3666a8f4c1d7340845f34636051f2f357af119e84e2a05fb4442d1f49b',
    recipientCommitment: '0xecc903a8d6583c956d238e1224074cb35de2960bd0a092e9b9d4bebacff08bcb',
    parentRecordId: '0xe24e95611787c13ff990f930ae7f5e4fd5aabbbc6c493929691180d708efe1a6',
    appId: '0x0c9a90b9b477b1e4a08fb1d5a42ae6c1b9ebad0109522c60807d599c134fb621',
    kind: 2,
    feeToken: '0x0000000000000000000000000000000000000000',
    maxFee: '0',
    nonce: '0',
    deadline: 0,
  },
} as const;

/** record-self-note: kind 6 NOTE, recipientCommitment 0. */
const RECORD_SELF_NOTE = {
  signer: '0x52eaefebe4ec263f7ffd6ca678613e4d6195868a',
  envelopeHash: '0x8f18f92224e601f0f7fda7f2f619c4309c76b334fac4ecfb9e27477c8df61719',
  feeToken: '0x05f7cddba6070777972ad9ff9df5312872a49685',
  maxFee: '1000000',
  nonce: '32335023169853923071254069445495495254027989318932054804258061970092455533438',
  deadline: 1760007200,
} as const;

/** receipt-delivered and receipt-accepted. */
const RECEIPTS = [
  {
    receiptType: 1,
    digest: '0x75144d891a9a823287c0e3e7d253f1b3fe7e767e3c0b8b305721bd3c4ec6e452',
    structHash: '0x0011a4dd597f7f77816f6db7c0d8bc7c98d628f9d8498e4888e4bb446d33397f',
  },
  {
    receiptType: 3,
    digest: '0xe260404b422198e2583d5291e835e961ceb55c67bc42bcbf450da8423c375c94',
    structHash: '0x8429ab8c6bbd1073486b5fcc153032b6f44190d9e21efc2511e2a1085e6d7b82',
  },
] as const;
const RECEIPT_SIGNER = '0xe09a6724ce75ed0badc4bb6a5ecf4f28e75ee558';
const RECEIPT_DEADLINE = 1760090000;

/** eip712 card-basic-hashes. */
const CARD_BASIC = {
  card: {
    version: 1,
    agentEvm: '0x18d675d5e86616dd150eb7f5bf5d91f3493a6094',
    agentNostr: '0xf68917cec79aeb0b70a1d9f6e4416ed4b7b7a0acd800813a17c810130cb9b369',
    agentEnc: '0x2aba325a155faa7f9bd9882dd91814cab80833832342d70d23a9cebb0784271c',
    ownerEvm: '0x974fdeb6d126f79e6c89dd2442aa52d934df8499',
    ownerNostr: '0x917490ad6f66af56e32df0e1ca3bce0bcbd4d0a33eb952d7515cede6e2f7c055',
    ownerEnc: '0x360bc8a58437d71de69a609e59a29fe243e25dc446fe96c8696cb85fd675aa34',
    nameHash: '0x67ebd76b640a9aac1f827bcbf2ce42191c0c44966942631ce4037418afddf160',
    relaysHash: '0xe779ed544022f1030efcd6271710c06dfe6cd4aab2a2f0eb169566f8cf90092f',
    issuedAt: 1760000000,
    expiresAt: 1791536000,
    keyEpoch: 0,
  },
  digest: '0x7abb5ab9667f7ee4d86adea395f4feea44a34df00a0937ac623fb3502642a711',
} as const;

// --- helpers -----------------------------------------------------------------------------------

function messageInput(overrides: Partial<RecordInput> = {}): RecordInput {
  const r = RECORD_MESSAGE.record;
  return {
    chainId: RECORD_MESSAGE.chainId,
    notary: RECORD_MESSAGE.notary,
    signer: r.signer,
    envelopeHash: r.envelopeHash,
    recipient: RECORD_MESSAGE.recipient,
    kind: RECORD_KIND.MESSAGE,
    feeToken: r.feeToken,
    maxFee: BigInt(r.maxFee),
    deadline: r.deadline,
    ...overrides,
  };
}

function digestOf(td: TypedData): string {
  return hex(hashTypedData(td).digest);
}

// --- parity ------------------------------------------------------------------------------------

describe('Record builder: EIP-712 vector parity (eip712-proof)', () => {
  it('record-message: same fields, commitment, digest and recordId', () => {
    const built = assembleRecord(messageInput(), {
      nonce: BigInt(RECORD_MESSAGE.record.nonce),
      salt: RECORD_MESSAGE.salt,
    });
    expect(built.record).toEqual(RECORD_MESSAGE.record);
    expect(built.digest).toBe(RECORD_MESSAGE.digest);
    expect(digestOf(built.typedData)).toBe(RECORD_MESSAGE.digest);
    expect(hex(hashTypedData(built.typedData).structHash)).toBe(RECORD_MESSAGE.structHash);
    expect(hex(hashTypedData(built.typedData).domainSeparator)).toBe(
      RECORD_MESSAGE.domainSeparator,
    );
    expect(built.recordId).toBe(RECORD_MESSAGE.recordId);
    expect(built.salt).toBe(RECORD_MESSAGE.salt);
  });

  it('record-message-chiado: the chain ID moves the domain and the digest', () => {
    const built = assembleRecord(messageInput({ chainId: 10200 }), {
      nonce: BigInt(RECORD_MESSAGE.record.nonce),
      salt: RECORD_MESSAGE.salt,
    });
    expect(built.digest).toBe(RECORD_MESSAGE_CHIADO_DIGEST);
  });

  it('record-reply-file: parent, appId, native fee token, zero nonce and deadline', () => {
    const r = RECORD_REPLY_FILE.record;
    const built = assembleRecord(
      messageInput({
        envelopeHash: r.envelopeHash,
        parentRecordId: r.parentRecordId,
        appId: r.appId,
        kind: RECORD_KIND.FILE,
        feeToken: r.feeToken,
        maxFee: 0n,
        deadline: 0,
      }),
      { nonce: 0n, salt: RECORD_REPLY_FILE.salt },
    );
    expect(built.record).toEqual(r);
  });

  it('record-self-note: no recipient gives commitment 0 and no salt', () => {
    const s = RECORD_SELF_NOTE;
    const built = assembleRecord(
      messageInput({
        envelopeHash: s.envelopeHash,
        recipient: null,
        kind: RECORD_KIND.NOTE,
        feeToken: s.feeToken,
        maxFee: BigInt(s.maxFee),
        deadline: s.deadline,
      }),
      { nonce: BigInt(s.nonce), salt: null },
    );
    expect(built.record.recipientCommitment).toBe(ZERO32);
    expect(built.salt).toBeNull();
  });

  it('accepts EIP-55 addresses and writes the 05 §3.1 JSON form (lowercase)', () => {
    const built = assembleRecord(
      messageInput({
        notary: '0x252D9A9c22652a8C08B12eda14D30906850542C9',
        signer: '0x52EaEFEBE4eC263f7fFD6ca678613e4d6195868A',
      }),
      { nonce: BigInt(RECORD_MESSAGE.record.nonce), salt: RECORD_MESSAGE.salt },
    );
    expect(built.digest).toBe(RECORD_MESSAGE.digest);
    expect(built.record.signer).toBe(RECORD_MESSAGE.record.signer);
  });
});

describe('Receipt builder: EIP-712 vector parity (eip712-proof)', () => {
  for (const v of RECEIPTS) {
    it(`receipt type ${String(v.receiptType)}`, () => {
      const built = buildReceipt({
        chainId: RECORD_MESSAGE.chainId,
        notary: RECORD_MESSAGE.notary,
        signer: RECEIPT_SIGNER,
        recordId: RECORD_MESSAGE.recordId,
        receiptType: v.receiptType,
        salt: RECORD_MESSAGE.salt,
        deadline: RECEIPT_DEADLINE,
      });
      expect(built.digest).toBe(v.digest);
      expect(digestOf(built.typedData)).toBe(v.digest);
      expect(hex(hashTypedData(built.typedData).structHash)).toBe(v.structHash);
    });
  }

  it('refuses receipt types outside 1..4 and a malformed salt or recordId', () => {
    const base = {
      chainId: RECORD_MESSAGE.chainId,
      notary: RECORD_MESSAGE.notary,
      signer: RECEIPT_SIGNER,
      recordId: RECORD_MESSAGE.recordId,
      receiptType: RECEIPT_TYPE.DELIVERED as number,
      salt: RECORD_MESSAGE.salt as string,
      deadline: RECEIPT_DEADLINE,
    };
    for (const receiptType of [0, 5, 255, 1.5]) {
      expect(() => buildReceipt({ ...base, receiptType })).toThrow();
    }
    expect(() => buildReceipt({ ...base, salt: '0x1234' })).toThrow();
    expect(() =>
      buildReceipt({ ...base, recordId: RECORD_MESSAGE.recordId.toUpperCase() }),
    ).toThrow();
  });
});

describe('AgentCard typed data: EIP-712 vector parity (eip712 card-basic-hashes)', () => {
  it('hashes to the vector digest under the chain-agnostic domain', () => {
    const td = agentCardTypedData(CARD_BASIC.card);
    expect(digestOf(td)).toBe(CARD_BASIC.digest);
    expect(td.domain).toEqual({ name: 'OCC AgentCard', version: '1' });
  });
});

// --- salts, nonces, kinds (04 §5, D-61, D-86) ----------------------------------------------------

describe('buildRecord: fresh CSPRNG salt and nonce for every Record', () => {
  it('two Records for the same envelope and recipient share no salt, nonce, commitment or ID', () => {
    const a = buildRecord(messageInput());
    const b = buildRecord(messageInput());
    expect(a.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
    expect(a.record.nonce).not.toBe(b.record.nonce);
    expect(a.record.recipientCommitment).not.toBe(b.record.recipientCommitment);
    expect(a.recordId).not.toBe(b.recordId);
  });

  it('the commitment is keccak256(abi.encode(recipient, salt)) with the returned salt', () => {
    const built = buildRecord(messageInput());
    expect(built.salt).not.toBeNull();
    expect(built.record.recipientCommitment).toBe(
      hex(recipientCommitment(RECORD_MESSAGE.recipient, built.salt as string)),
    );
  });

  it('the recordId is the contract derivation over the generated nonce', () => {
    const built = buildRecord(messageInput());
    const again = assembleRecord(messageInput(), {
      nonce: BigInt(built.record.nonce),
      salt: built.salt,
    });
    expect(again.recordId).toBe(built.recordId);
    expect(again.digest).toBe(built.digest);
  });

  it('takes no salt, nonce or commitment from its caller (D-61)', () => {
    for (const key of ['salt', 'nonce', 'recipientCommitment', 'extra']) {
      const input = { ...messageInput(), [key]: RECORD_MESSAGE.salt } as unknown as RecordInput;
      expect(() => buildRecord(input)).toThrow();
    }
  });

  it('exposes no salt derivation and no way to pass one in', () => {
    const names = Object.keys(typedDataModule);
    expect(names).not.toContain('assembleRecord');
    expect(names.filter((n) => /salt|nonce|derive/i.test(n))).toEqual([]);
  });

  it('accepts the 05 §3.1 kinds 1..6 only (D-86; 7..255 are reserved)', () => {
    expect(RECORD_KIND).toEqual({
      MESSAGE: 1,
      FILE: 2,
      OFFER: 3,
      ACCEPT: 4,
      DELIVERY: 5,
      NOTE: 6,
    });
    for (const kind of Object.values(RECORD_KIND)) {
      expect(buildRecord(messageInput({ kind })).record.kind).toBe(kind);
    }
    for (const kind of [0, 7, 255, 1.5, -1]) {
      expect(() => buildRecord(messageInput({ kind: kind as 1 }))).toThrow();
    }
  });

  it('refuses malformed fields without echoing them', () => {
    const cases: Partial<RecordInput>[] = [
      { signer: '0xnot-an-address' },
      { recipient: '0x1234' },
      { envelopeHash: '0x1234' },
      { envelopeHash: RECORD_MESSAGE.record.envelopeHash.toUpperCase() },
      { feeToken: 'USDC' },
      { maxFee: -1n },
      { maxFee: 1n << 256n },
      { deadline: -1 },
      { deadline: 2 ** 53 },
      { chainId: 0 },
      { notary: '0x' },
      { parentRecordId: '0x00' },
      { appId: 'not-hex' },
    ];
    for (const c of cases) {
      let thrown: unknown;
      try {
        buildRecord(messageInput(c));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain('not-an-address');
      expect((thrown as Error).message).not.toContain('not-hex');
    }
  });

  it('returns frozen results', () => {
    const built = buildRecord(messageInput());
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.record)).toBe(true);
    expect(Object.isFrozen(built.domain)).toBe(true);
  });
});

// --- signing goes through KeyStore.sign712 only ---------------------------------------------------

describe('signing through KeyStore.sign712', () => {
  const SIG = `0x${'ab'.repeat(65)}`;

  it('signRecord, signReceipt and signAgentCard hand the exact typed data to sign712', async () => {
    const sign712 = vi.fn((td: TypedData) => Promise.resolve(`${SIG}|${digestOf(td)}`));
    const keyStore = { sign712 };
    const record = buildRecord(messageInput());
    expect(await signRecord(keyStore, record)).toBe(`${SIG}|${record.digest}`);
    const receipt = buildReceipt({
      chainId: 84532,
      notary: RECORD_MESSAGE.notary,
      signer: RECEIPT_SIGNER,
      recordId: record.recordId,
      receiptType: RECEIPT_TYPE.DELIVERED,
      salt: record.salt as string,
      deadline: RECEIPT_DEADLINE,
    });
    expect(await signReceipt(keyStore, receipt)).toBe(`${SIG}|${receipt.digest}`);
    expect(await signAgentCard(keyStore, CARD_BASIC.card)).toBe(`${SIG}|${CARD_BASIC.digest}`);
    expect(sign712).toHaveBeenCalledTimes(3);
  });

  it('refuses a Record whose typed data no longer matches its digest', async () => {
    const sign712 = vi.fn(() => Promise.resolve(SIG));
    const record = buildRecord(messageInput());
    const tampered = { ...record, digest: RECORD_MESSAGE.digest };
    await expect(signRecord({ sign712 }, tampered)).rejects.toThrow();
    expect(sign712).not.toHaveBeenCalled();
  });
});
