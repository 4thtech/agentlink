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
  firstProofFree: 'Free test credits arrive automatically with your first proof.',
  addCreditsNotAvailable: 'Adding credits is not available yet in this version of AgentLink.',
  creditsUnavailable: "Credits can't be checked right now. Try again in a minute.",
  creditsPartial: "Some credits couldn't be checked just now, so you may have more.",
  // M1-11c-a4c: Add credits by QR (Gnosis test network now) and Withdraw credits (D-122, D-123).
  // The network and coin are named only inside Add credits, because the sender's app asks for
  // them (topup-ux.md 3c, D-117 B); the default view stays plain.
  addCredits: 'Add credits',
  addCreditsTitle: 'Add credits',
  addCreditsIntro: 'Send test xDAI to your agent, then turn it into credits here.',
  networkLabel: 'Network',
  coinLabel: 'Coin',
  coin: 'xDAI (test)',
  addressLabel: "Your agent's address",
  qrLabel: "QR code of your agent's address",
  copyAddress: 'Copy address',
  copied: 'Copied',
  copyFailed: 'Copy did not work. Select the address and copy it.',
  // 11 §5.6 "Top-up (each method, once)", verbatim.
  privacy:
    'The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink.',
  checkAgain: 'Check again',
  reserveNote: 'A little stays with your agent to cover network costs.',
  advanced: 'Advanced',
  withdraw: 'Withdraw credits',
  withdrawNote:
    "Credits go back to your agent's own account. Sending them to another account comes in a later update.",
  confirmTitle: 'Confirm',
  amountLabel: 'Amount',
  fromLabel: 'From',
  toLabel: 'To',
  fromReceived: 'Funds your agent received',
  toCredits: 'Your credits',
  fromCredits: 'Your credits',
  toOwnAccount: "Your agent's own account",
  ownerCode: 'Backup code',
  confirm: 'Confirm',
  cancel: 'Cancel',
  working: 'Working…',
  done: 'Done. Your credits are updated.',
  pending: 'Sent. Your credits update in a minute.',
  wrongCode: "That backup code didn't work.",
  wait: 'Too many tries. Wait a moment, then try again.',
  amountChanged: 'The amount changed. Check again.',
  noFundsForFee: "Your agent's account needs a little more to cover network costs.",
  moveFailed: "That didn't go through. Try again in a minute.",
  // UX2-e2: the Add credits tracker (B-11 §23.1, D-137). Funds, account, credits; never "wallet",
  // "deposit", "transaction" or "address" in these steps.
  trackLabel: 'Adding credits, step by step',
  detailsLabel: 'Where to send your funds',
  stepWaiting: 'Waiting for your funds',
  stepWaitingHint: 'Usually takes about a minute.',
  stepWaitingLong: 'Still waiting. Check that you sent it to this account.',
  showDetails: 'Show details again',
  stepArrived: 'Arrived',
  stepAdding: 'Adding to your credits…',
  stepAdded: 'Added to credits',
  readFailed: "Couldn't check. Trying again.",
  stoppedChecking: 'Stopped checking.',
} as const;

/** The networks the page names, by the server's fixed word (11 §5: plain words). */
export const NETWORK_NAMES = {
  'gnosis-test': 'Gnosis test network',
  'base-test': 'Base test network',
} as const;

export function comingSoon(network: string): string {
  return `${network}: coming soon`;
}

export function addAmount(usd: string): string {
  return `Add ${usd} to your credits`;
}

/** The Arrived step with the `received` value of the read that proved it. */
export function arrivedAmount(usd: string): string {
  return `Arrived · ${usd}`;
}

/** The Added step with the credits read after the owner operation succeeded. */
export function addedNow(usd: string): string {
  return `Added to credits · ${usd} now`;
}

/** Read after the step word by screen readers ("Waiting for your funds, step 1 of 3"). */
export function stepOf(n: number): string {
  return `, step ${String(n)} of 3`;
}

/** The polite announcement when funds arrive. */
export function fundsArrived(usd: string): string {
  return `Your funds arrived: ${usd}`;
}

export function withdrawAmount(usd: string): string {
  return `Withdraw ${usd} of credits`;
}

export function proofsLeft(n: number): string {
  return n === 1 ? '1 proof left' : `${String(n)} proofs left`;
}

/** The price line; `price` comes from the server (core's schedule), never a literal here. */
export function priceLine(price: string): string {
  return `A proof costs ${price}, including up to 3 receipts. Messages and files are always free.`;
}

export function inCredits(balance: string): string {
  return `${balance} in credits`;
}
