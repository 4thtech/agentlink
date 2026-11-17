// SEC-RECEIPTS-DEFAULT: the "automatic device receipt" in a proof pack (07 §8). The recipient AI's
// signed "received" ack travels with the pack, labelled apart from on-chain receipts, and the
// verifier checks it on its own: signature, content key, strict ack body, and the pack's hash.
import { checkDeviceReceipt } from '@4thtech-io/chain';
import { encodeBase64url, encodeHex, generateCek } from '@4thtech-io/crypto';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { proofPackDeviceReceiptSchema } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { DEVICE_RECEIPT_LABEL, ackPayload } from './acks.js';
import { seed } from './testing/fixtures.js';
import { agentSigner, craft } from './testing/envelopes.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const HASH = `0x${'11'.repeat(32)}`;

async function receipt(options: { readonly hash?: string; readonly tamperCt?: boolean } = {}) {
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
  const signerNostr = encodeHex((await recipient.getPublicBundle()).agentNostr);
  return {
    value: { label: DEVICE_RECEIPT_LABEL, envelope, contentKey: encodeBase64url(cek) },
    signerNostr,
  };
}

describe('proof pack: automatic device receipt', () => {
  it('the pack member carries the label, and no other label parses', async () => {
    const { value } = await receipt();
    expect(proofPackDeviceReceiptSchema.safeParse(value).success).toBe(true);
    expect(proofPackDeviceReceiptSchema.safeParse({ ...value, label: 'delivered' }).success).toBe(
      false,
    );
  });

  it('verifies a receipt signed by the recipient AI over the pack hash', async () => {
    const { value, signerNostr } = await receipt();
    const result = await checkDeviceReceipt(value, HASH);
    expect(result).toEqual({
      ok: true,
      label: 'automatic device receipt',
      signer: signerNostr,
      at: 1_800_000_000,
    });
  });

  it('a receipt for another hash, or a tampered one, fails', async () => {
    const other = await receipt({ hash: `0x${'22'.repeat(32)}` });
    expect(await checkDeviceReceipt(other.value, HASH)).toMatchObject({ ok: false });
    const tampered = await receipt({ tamperCt: true });
    expect(await checkDeviceReceipt(tampered.value, HASH)).toMatchObject({ ok: false });
    const relabelled = await receipt();
    expect(
      await checkDeviceReceipt({ ...relabelled.value, label: 'delivered' }, HASH),
    ).toMatchObject({ ok: false });
  });
});
