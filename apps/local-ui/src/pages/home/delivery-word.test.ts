// SEC-RECEIPTS-DEFAULT: the sender's delivery word (11 §5). "Received by <name>'s app" only on a
// receipt the contact's AI signed over this exact message; an older app's receipt is weaker; a
// message sent with proof never reads as delivered without that receipt.
import { describe, expect, it } from 'vitest';
import { receiptWord, sentWord } from './delivery-word.js';

const item = (over: Record<string, unknown> = {}) => ({
  status: 'sent' as const,
  receipt: false,
  proof: false,
  ...over,
});

describe('sentWord', () => {
  it('Sent until a receipt arrives, then received by their app', () => {
    expect(sentWord(item(), 'Ana')).toBe('Sent');
    expect(sentWord(item({ receipt: true }), 'Ana')).toBe("Received by Ana's app");
  });

  it('an older app receipt reads as weaker, never as verified', () => {
    expect(sentWord(item({ receivedOlder: true }), 'Ana')).toBe('Received (older app)');
  });

  it('proof: never delivered without the signed receipt', () => {
    expect(sentWord(item({ proof: true }), 'Ana')).toBe('Sent. No receipt yet.');
    expect(sentWord(item({ proof: true, receivedOlder: true }), 'Ana')).toBe(
      'Sent. No receipt yet.',
    );
    expect(sentWord(item({ proof: true, receipt: true }), 'Ana')).toBe(
      "Delivered: Ana's AI confirmed it received this.",
    );
  });

  it('other states keep their word', () => {
    expect(sentWord(item({ status: 'queued' }), 'Ana')).toBe('Waiting to send');
    expect(sentWord(item({ status: 'not_delivered' }), 'Ana')).toBe('Not delivered');
  });
});

describe('receiptWord (Under the hood)', () => {
  it('Delivered only with the signed receipt (11 §5.10)', () => {
    expect(receiptWord(item({ receipt: true }), 'Ana')).toBe(
      "Received by Ana's app: their AI app confirmed it received this exact message.",
    );
    expect(receiptWord(item({ receipt: true, proof: true }), 'Ana')).toBe(
      "Delivered: Ana's AI confirmed it received this.",
    );
    expect(receiptWord(item({ receivedOlder: true }), 'Ana')).toBe('Received (older app)');
    expect(receiptWord(item({ receivedOlder: true, proof: true }), 'Ana')).toBe(
      'Sent. No receipt yet.',
    );
    expect(receiptWord(item(), 'Ana')).toBe('No receipt yet');
    expect(receiptWord(item({ status: 'queued' }), 'Ana')).toBe('Pending');
  });

  it('no word says wallet, gas, seed phrase or transaction', () => {
    const words = [
      sentWord(item({ receipt: true }), 'Ana'),
      sentWord(item({ receivedOlder: true }), 'Ana'),
      sentWord(item({ proof: true }), 'Ana'),
      receiptWord(item({ receivedOlder: true }), 'Ana'),
    ].join(' ');
    expect(words).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });
});
