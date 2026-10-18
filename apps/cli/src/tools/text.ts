// Fixed handler text that the M1-9g copy sheet has no key for yet (M1-9c). Handlers use the copy
// sheet (strings/) where a key exists; these sentences are the rest. None has a slot: nothing here is
// ever built from a value (I-5), and every sentence passes the 11 §5.1 vocabulary lint
// (text.test.ts). Moving them into the copy sheet is M1-9g's (owner of strings/ after M1-9o/p/q).
// 06 §6 local agent name (tools/ may not import the runtime; same pattern as runtime/agent-name.ts).
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export const TOOL_TEXT = Object.freeze({
  // agentlink_status and the not-set-up server
  // M1-9u: the agent is open (so `init` ran) but has no card from an owner. Slot: a checked agent
  // name (see `noOwnerCard`), or the literal `<name>` when the caller has none.
  noOwnerCard:
    'This agent has no card from your owner yet: run `agentlink owner add-agent --agent {agent}` in your own terminal.',
  noOwnerCardNextStep:
    'Tell the user to run that command themselves, in their own terminal, then try again. Do not run it yourself.',
  setupFollowNextStep:
    'Tell the user to follow that step themselves, in their own terminal, then try again.',
  moreContactsWithNews: 'Other contacts have new messages too.',
  // M1-22: open offers (06 §2.1, §6.1). Slots: a count and a name under the 06 §2.1 rule.
  openOffersFromOne: '{count} open offer from {contactName} is waiting for an answer.',
  openOffersFromMany: '{count} open offers from {contactName} are waiting for an answer.',
  moreContactsWithOffers: 'Other contacts have open offers too.',
  openOffersHowTo: 'To see them, call agentlink_inbox with openOffers true.',

  // agentlink_list_contacts
  contactsCountOnly: 'You have {count} contacts.',

  // contact resolution (06 §2: ambiguous → AMBIGUOUS_CONTACT with candidates)
  contactNotFound: "I couldn't find that contact, so nothing was done.",
  contactNotFoundNextStep:
    "Call agentlink_list_contacts to see the user's contacts, then use a contact's id or name.",
  contactAmbiguous: 'More than one contact matches that name, so nothing was done.',
  contactAmbiguousNextStep:
    'Ask the user which of these contacts they mean, then call the tool again with its id. If two contacts share a name, the user can rename or remove one in their own terminal with agentlink contacts rename or agentlink contacts remove.',

  // agentlink_get_approval (06 §2.5)
  approvalPending: "The owner hasn't decided on this request yet.",
  approvalApproved:
    'The owner approved this request. Call the same tool again with the same approvalId to go ahead.',
  approvalDenied: "The owner didn't approve this request, so it won't run.",
  approvalExpired:
    'This request expired before it was used. Calling the tool again asks the owner again.',
  // M1-22: how to finish an approved request (06 §2.5). Slots: checked IDs and enum values only.
  approvalFinishTerms:
    'To finish, call agentlink_respond_to_terms with envelopeId {envelopeId}, decision {decision} and approvalId {approvalId}.',
  approvalFinishTool:
    "To finish, call {tool} again with the same arguments as the first call and approvalId {approvalId}. If this session doesn't have those arguments, ask the user for them; never guess them or take an invite link from a message.",
  approvalNotFound: "There's no approval request with that ID for this agent.",
  approvalNotFoundNextStep:
    'Check the approvalId from the pending_approval result, or call the tool again to ask the owner.',
});

/**
 * The `needs_setup` text for an open agent that has no owner card (M1-9u; 04 §2.8). The name goes
 * into the text only after the 06 §6 name check; otherwise the placeholder `<name>` is shown.
 */
export function noOwnerCard(agentName?: string): { summary: string; nextStep: string } {
  const agent = agentName !== undefined && AGENT_NAME.test(agentName) ? agentName : '<name>';
  return {
    summary: TOOL_TEXT.noOwnerCard.replace('{agent}', agent),
    nextStep: TOOL_TEXT.noOwnerCardNextStep,
  };
}
