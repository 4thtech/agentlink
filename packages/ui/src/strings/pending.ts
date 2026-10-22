// Strings that wait for the owner's Claude Design redesigns (DESIGN-ADJ-1 (b) briefs). They are not
// shipped and no copy is invented here: each entry only names what the redesign must supply, so the
// building card can add the key when the brief lands. A key listed here must not exist in `en`.

export interface PendingString {
  readonly key: string;
  readonly brief: 'B-1' | 'B-2' | 'B-8';
  readonly needs: string;
}

export const pendingStrings: readonly PendingString[] = [
  // B-1 · Receipt request card (Activity, contact detail, console home, browser accept). The 11 §5.6
  // lines for the request itself are shipped as `common.public.receiptRequest*`.
  { key: 'common.receiptCard.title', brief: 'B-1', needs: 'Card heading and sender line' },
  { key: 'common.receiptCard.state.confirmed', brief: 'B-1', needs: 'Confirmed state' },
  { key: 'common.receiptCard.state.declined', brief: 'B-1', needs: 'Not now state' },
  {
    key: 'common.receiptCard.autoConfirm.toggle',
    brief: 'B-1',
    needs: 'Label of the automatic-confirmation control beside the card',
  },
  // B-2 · Review together (local Approvals, console Approvals; ApprovalCard batch variant).
  {
    key: 'local.approvals.batch.heading',
    brief: 'B-2',
    needs: 'Waiting-for-you heading with count',
  },
  { key: 'local.approvals.batch.later', brief: 'B-2', needs: 'Later button' },
  {
    key: 'local.approvals.batch.confirm',
    brief: 'B-2',
    needs: 'Button naming exactly what is approved',
  },
  { key: 'local.approvals.batch.empty', brief: 'B-2', needs: 'Empty state' },
  // B-8 · Export proof dialog (Proof detail, local Proofs, console). The 11 §5.6 export line is
  // shipped as `common.public.export`.
  { key: 'common.export.title', brief: 'B-8', needs: 'Dialog title' },
  { key: 'common.export.option.recipient', brief: 'B-8', needs: 'Include-the-recipient option' },
  {
    key: 'common.export.option.documentKey',
    brief: 'B-8',
    needs: 'Include-the-document-key option',
  },
  { key: 'common.export.action', brief: 'B-8', needs: 'Primary button and saved confirmation' },
];
