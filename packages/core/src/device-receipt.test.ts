// SEC-RECEIPTS-DEFAULT: the automatic device receipt in a proof pack (07 §8 "Automatic device
// receipts"). The contact AI's signed "received" ack travels with the sender's pack, with the
// contact's card, apart from on-chain receipts, and the verifier checks each entry on its own:
// card, signature, content key, strict ack body, and the pack's hash. Any failure is the fixed code
// `device_receipt_invalid`. The end-to-end pass (a real card) is in proofs/proofs.test.ts.
import { checkDeviceReceipt } from '@4thtech-io/chain';
import { encodeBase64url, generateCek } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { proofPackDeviceReceiptSchema, proofPackSchema } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { DEVICE_RECEIPT_LABEL, ackPayload } from './acks.js';
import { seed } from './testing/fixtures.js';
import { agentSigner, craft } from './testing/envelopes.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const HASH = `0x${'11'.repeat(32)}`;

async function entry(options: { readonly hash?: string; readonly tamperCt?: boolean } = {}) {
  const recipient = new MemoryKeyStore(seed(7));
  const sender = new MemoryKeyStore(seed(8));
  const cek = generateCek();
  const envelope = await craft({
    signer: await agentSigner(recipient),
    entries: [
      { pk: (await sender.getPublicBundle()).agentEnc },
      { pk: (await recipient.getPublicBundle()).agentEnc },
    ],
    payload: ackPayload(ID, options.hash ?? HASH),
    cek,
    createdAt: 1_800_000_000,
    ...(options.tamperCt === true ? { tamperCt: true } : {}),
  });
  return { envelope, contentKey: encodeBase64url(cek) };
}

describe('proof pack: automatic device receipt', () => {
  it('is labelled as such, never as a public receipt', () => {
    expect(DEVICE_RECEIPT_LABEL).toBe('automatic device receipt');
  });

  it('an entry needs the contact card; a label or any other key does not parse', async () => {
    const e = await entry();
    expect(proofPackDeviceReceiptSchema.safeParse(e).success).toBe(false);
    expect(
      proofPackDeviceReceiptSchema.safeParse({ ...e, label: DEVICE_RECEIPT_LABEL }).success,
    ).toBe(false);
    expect(proofPackSchema.shape.deviceReceipts).toBeDefined();
  });

  it('an entry without a valid card, for another hash, or tampered fails with device_receipt_invalid', async () => {
    const bogusCard = { agentCard: { v: 1 }, cardSig: `0x${'00'.repeat(65)}` };
    for (const e of [
      await entry(),
      await entry({ hash: `0x${'22'.repeat(32)}` }),
      await entry({ tamperCt: true }),
    ]) {
      expect(await checkDeviceReceipt({ ...e, card: bogusCard }, HASH)).toEqual({
        ok: false,
        reason: 'device_receipt_invalid',
      });
    }
    expect(await checkDeviceReceipt('not an entry', HASH)).toEqual({
      ok: false,
      reason: 'device_receipt_invalid',
    });
  });
});
