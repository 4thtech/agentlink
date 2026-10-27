// Activity page copy (M1-11c-a1; 11 §5: plain words, no "wallet", "chain", "transaction", "hash" or
// "policy"). Checked by strings.test.ts against the 11 §5.1 never-say list.
export const ACTIVITY_STRINGS = {
  title: 'Activity',
  tableLabel: 'Activity, newest first',
  colTime: 'Time',
  colWhat: 'What',
  colContact: 'Contact',
  colStatus: 'Status',
  loading: 'Loading activity…',
  // Filters, live state
  filterLabel: 'Show',
  filterAll: 'All',
  filterApprovals: 'Approvals',
  filterProofs: 'Proofs',
  filterOther: 'Blocks and rules',
  filterEmpty: 'Nothing of this kind yet.',
  asOf: 'As of',
  // Approvals
  approved: 'You approved a request',
  approvedByRules: 'Approved by your rules',
  denied: 'You denied a request',
  cancelled: 'You cancelled a request',
  cancelledChip: 'Cancelled',
  // Proofs
  proofSent: 'Proof for a message you sent',
  proofReceived: 'A contact added proof to a message for you',
  // Blocks and rules
  senderBlocked: 'You blocked an unknown sender',
  senderPrefix: 'Sender',
  contactBlocked: 'You blocked a contact',
  rulesChanged: 'Your rules were updated',
  none: '—',
  // Paging
  showMore: 'Show more',
  loadingMore: 'Loading…',
  // Empty
  emptyTitle: 'Nothing here yet. Approvals, proofs and blocked senders show up here.',
  emptyPrompt: 'ask your AI to send a message to a contact with proof',
  // Problems
  tryAgain: 'Try again',
  errorTitle: "Activity didn't load.",
  errorBody: 'Nothing changed. Try again in a moment.',
  offlineTitle: "Can't reach AgentLink on this computer.",
  offlineBody: 'Check that your AI app is still open, then try again.',
  sessionTitle: 'This page has ended.',
  sessionBody: 'Ask your AI to open AgentLink again.',
  notSetUpTitle: "AgentLink isn't set up on this computer yet.",
  notSetUpPrompt: 'ask your AI to set up AgentLink',
} as const;
