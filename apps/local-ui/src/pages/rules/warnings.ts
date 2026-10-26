// D-119: the plain words for every warning code core's preparePolicyEdit returns (06 §3; 11 §5,
// §5.6). The confirm screen shows each one and the owner ticks each before saving; the server refuses
// to sign while any is not acknowledged. packages/node/src/local-ui/api/rules.test.ts checks that
// every core code (POLICY_EDIT_WARNING_CODES) has an entry here, so a new code fails CI until it has
// text. Each sentence says what the agent may now do without asking, never a field name or ID.

export const WARNING_TEXT = Object.freeze({
  invites_auto: 'Your agent will connect with new contacts without asking you.',
  unknown_senders_queued:
    'Requests from unknown senders will be held for your review instead of dropped.',
  contacts_allowed_widened: 'More agents will be able to message your agent.',
  limits_raised:
    'Some limits go up: how often contacts can message, how large files can be, or how long file links last.',
  retention_longer: 'Files will be kept longer than before.',
  allowed_folders_added: 'Your agent will be able to send files from more folders.',
  folder_changed: 'The folder where your agent saves files or proofs changes.',
  files_drop_allowed: 'Files may go through the encrypted drop, not only your own storage.',
  proofs_notarize_looser:
    'Your agent will add proof with fewer questions to you. Each proof uses credits and is public.',
  proofs_spend_raised: 'Your agent can spend more on proofs without asking you.',
  key_disclosure_approval:
    'Your agent can ask you to let an export open the document. Anyone with that export could read it.',
  proofs_chain_changed: 'Your proofs will be recorded and paid for in a different place.',
  delivery_receipts_public:
    'Your agent will confirm deliveries automatically. Each confirmation shows publicly that a proof reached your agent.',
  opened_receipts_auto:
    'Your agent will confirm automatically when it opens something. Each confirmation is public.',
  commitments_looser: 'Your agent can accept terms again. It still asks you every time.',
  commitments_allow:
    'Your agent can accept terms, make firm offers and turn down terms without asking you. Accepting commits you.',
  auto_accept_widened:
    'Your agent can accept more agreements without asking you, when you are the one who pays.',
  sell_auto_accept:
    'Your agent will commit you to deliver whatever this contact writes, for at least {amount}. Only turn this on for contacts you trust.',
  contact_proof_rules_looser: 'Proofs become less strict for some contacts.',
  contact_receipts_public:
    'Deliveries from some contacts will be confirmed automatically. Each confirmation is public.',
  contact_rule_removed_loosens:
    'Removing a rule for a contact makes things less strict for that contact.',
} as const);

export type WarningCode = keyof typeof WARNING_TEXT;

export const WARNING_CODES = Object.freeze(Object.keys(WARNING_TEXT) as WarningCode[]);

/** For a code the page does not know yet: still a warning the owner must tick. */
export const UNKNOWN_WARNING = 'Another rule becomes less strict.';

/** When the owner has not entered an amount yet. */
const SOME_AMOUNT = 'the amount you set';

/** The sentence for `code`, with `{amount}` filled in (the sell warning, 06 §3). */
export function warningText(code: string, values: { readonly amount?: string } = {}): string {
  if (!Object.hasOwn(WARNING_TEXT, code)) return UNKNOWN_WARNING;
  return WARNING_TEXT[code as WarningCode].replace('{amount}', values.amount ?? SOME_AMOUNT);
}
