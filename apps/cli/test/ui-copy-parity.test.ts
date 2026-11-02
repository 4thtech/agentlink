// W7-ID-B4 (D-144, 11 §5.6): the "what a proof makes public" lines, and the in-chat lines both
// catalogues carry, are word for word the same here and in `packages/ui` (the app's copy). The test
// reads the ui catalogue as text (`packages/mcp-tools` may not import Node built-ins or
// `packages/ui`, so the check lives here), so the two cannot drift. The only allowed difference: the receipt word is the fixed `{receipt}` slot here and an ICU
// select in the ui catalogue.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en, type CopyKey } from '@4thtech-io/mcp-tools/strings/index.js';

const UI_EN = fileURLToPath(new URL('../../../packages/ui/src/strings/en.ts', import.meta.url));

/** mcp-tools key → packages/ui key. */
const PAIRS: readonly (readonly [CopyKey, string])[] = [
  ['common.privacy.proof', 'common.public.proof'],
  ['common.privacy.proofReceipt', 'common.public.proof.receipt'],
  ['common.privacy.receiptAsk', 'common.public.receiptAsk'],
  ['common.privacy.receiptRequest', 'common.public.receiptRequest'],
  ['common.privacy.receiptRequestConfirm', 'common.public.receiptRequest.confirm'],
  ['common.privacy.receiptRequestLater', 'common.public.receiptRequest.later'],
  ['common.privacy.receiptAuto', 'common.public.autoConfirm'],
  ['common.privacy.receiptPublic', 'common.public.receipt'],
  ['common.privacy.topUp', 'common.public.topup'],
  ['common.privacy.export', 'common.public.export'],
  ['common.privacy.registered', 'common.public.register'],
  ['chat.status.rejected.rules', 'chat.status.rejected.rules'],
];

const RECEIPT_SELECT =
  '{action, select, opened {opened} accepted {accepted} rejected {rejected} other {received}}';

/** The string literal for `key` in the ui catalogue source (single- or double-quoted, one line). */
function uiString(source: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `'${escaped}':\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`,
  ).exec(source);
  if (match === null) return undefined;
  const raw = match[1] ?? match[2] ?? '';
  return raw.replace(/\\(.)/g, '$1');
}

describe('11 §5.6 parity with packages/ui (D-144)', () => {
  const source = readFileSync(UI_EN, 'utf8');
  for (const [ours, theirs] of PAIRS) {
    it(`${ours} equals ui ${theirs}`, () => {
      const ui = uiString(source, theirs);
      expect(ui).toBeDefined();
      expect(en[ours]).toBe(ui?.replace(RECEIPT_SELECT, '{receipt}'));
    });
  }
});
