// Proofs and credits copy (11 §5: credits in dollars and proofs, never a token, network, address or
// "wallet", "gas", "seed phrase" or "transaction"; DESIGN-ADJ-1 PR-1, PC-2, X-4, X-6).
export const PROOFS_STRINGS = {
  listCaption: 'Your proofs, newest first',
  colProof: 'Proof',
  colWhen: 'When',
  colStatus: 'Status',
  sent: 'Sent',
  received: 'Received',
  loading: 'Loading…',
  loadMore: 'Show more',
  emptyTitle: 'No proofs yet. Ask your AI to send something with proof.',
  emptyPrompt: 'Send contract.pdf to Marko with proof.',
  listUnavailable: "Your proofs can't be loaded right now. Try again in a minute.",
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  creditsLabel: 'Credits',
  testCreditsLabel: 'Test credits',
  testCredits: 'During the beta, proofs use free test credits.',
  addCreditsNotAvailable: 'Adding credits is not available yet in this version of AgentLink.',
  creditsUnavailable: "Credits can't be checked right now. Try again in a minute.",
  creditsPartial: "Some credits couldn't be checked just now, so you may have more.",
  price: 'A proof costs $0.10, including up to 3 receipts. Messages and files are always free.',
} as const;

export function proofsLeft(n: number): string {
  return n === 1 ? '1 proof left' : `${String(n)} proofs left`;
}

export function inCredits(balance: string): string {
  return `${balance} in credits`;
}
