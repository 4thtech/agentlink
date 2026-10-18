// Fixed text of the owner commands (M1-9b) that the M1-9g catalogue (src/tools/strings/en.ts) has no
// entry for yet. Every line is fixed: nothing the caller typed and no stored value is ever inserted
// (I-5), except the local agent names `addAgentUnreadable` lists, which passed isAgentName. The
// catalogue entries that exist (`cli.approve.*`) are used through `copy()`.
export const OWNER_TEXT = Object.freeze({
  // Card facts (11 §5 vocabulary).
  free: 'Free',
  noteToSelf: 'You (a note to yourself)',
  noContact: 'No contact',
  notAContact: 'Someone who is not in your contacts yet',
  /** `name` is the already-sanitized “name” (self-declared) form, or '' when there is none. */
  inviter: (name: string, fingerprint: string): string =>
    `${name === '' ? '' : `${name} · `}owner ${fingerprint} · not in your contacts yet`,
  unknownWhat: 'An action AgentLink does not recognise',
  consequence:
    'If you approve, your AI can do exactly this, once, before it expires. If you deny, nothing is sent.',
  cannotApprove: "Your AI can't approve this for you.",

  // Finding the request.
  notFound: 'No approval with that ID is waiting on this machine. Check the ID, or add --agent.',
  notPending:
    "That approval isn't waiting for a decision any more: it was already decided, cancelled or has expired.",
  problem:
    "Problem  This approval doesn't match what was requested, so it can't be approved. Ask your AI to make the request again.",
  problemTerms:
    "Problem  These terms don't match what was requested, so they can't be approved. Ask your AI to make the request again.",
  problemListed:
    "Problem  One approval doesn't match what was requested, so it isn't offered. Ask your AI to make the request again.",
  noIdentity:
    "This agent isn't fully set up yet, so there is nothing to approve. Run `agentlink doctor` in your own terminal.",
  severalAgents: 'Which agent? Type its number:',
  agentNotChosen: 'No agent was chosen. Nothing was changed.',

  // Batch review (04 §2.5.2, D-68).
  nothingDecided: 'Nothing was decided. Everything stays waiting.',
  moreWaiting: 'More are waiting. Review them next, or each with `agentlink approve <approvalId>`.',
  dropped: 'No longer waiting, so left out:',
  heldBack: 'Waiting  Held back because another item failed; still waiting for you:',
  noneLeft: 'None of your choices is still waiting. Nothing was changed.',

  // Cancel (D-55, 04 §3.4.2 rule 6).
  cancelNotPossible:
    "That approval can't be cancelled: it was already used, denied, cancelled or has expired.",
  cancelSummary: 'Cancel this approval. Anything it has not been used for yet will not happen.',
  cancelled: 'OK       Cancelled. Nothing more will be sent or recorded for it.',
  cancelFailed: "Problem  The cancel didn't go through. Nothing was changed.",

  // Owner add-agent (M1-9t, D-78; 04 §2.8).
  addAgentDone: 'OK       This agent can now pair. Restart the app that runs it.',
  addAgentUnknown:
    'AgentLink is not set up for this agent on this machine yet. Run `agentlink init --agent <name>` yourself first, in your own terminal.',
  addAgentHasCard:
    'This agent already has a card from an owner. AgentLink never replaces a card. Nothing was changed.',
  // IR-M1-9x-1 M-2: names only local agent names that passed isAgentName (I-5).
  addAgentUnreadable: (agents: readonly string[]): string =>
    `AgentLink couldn't read these agents on this computer, so it can't tell which owner they name: ${agents.join(', ')}. Nothing was changed. Run \`agentlink doctor\` in your own terminal, then try again.`,
  addAgentSeveralOwners:
    "The agents on this computer name different owners, so AgentLink can't tell which one to use. Nothing was changed. Run `agentlink doctor` in your own terminal.",

  // Owner init.
  ownerUnknownAgent:
    'AgentLink is not set up for this agent on this machine yet. Run `agentlink init` yourself, in your own terminal.',
});
