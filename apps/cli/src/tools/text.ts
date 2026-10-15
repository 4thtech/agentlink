// Fixed handler text that the M1-9g copy sheet has no key for yet (M1-9c). Handlers use the copy
// sheet (strings/) where a key exists; these sentences are the rest. None has a slot: nothing here is
// ever built from a value (I-5), and every sentence passes the 11 §5.1 vocabulary lint
// (text.test.ts). Moving them into the copy sheet is M1-9g's (owner of strings/ after M1-9o/p/q).
export const TOOL_TEXT = Object.freeze({
  // agentlink_status and the not-set-up server
  noIdentity: 'AgentLink is not set up for this agent on this machine yet, so nothing was checked.',
  setupNextStep:
    'Tell the user to run `agentlink init` themselves, in their own terminal, then try again.',
  setupFollowNextStep:
    'Tell the user to follow that step themselves, in their own terminal, then try again.',
  moreContactsWithNews: 'Other contacts have new messages too.',

  // agentlink_list_contacts
  contactsCountOnly: 'You have {count} contacts.',

  // contact resolution (06 §2: ambiguous → AMBIGUOUS_CONTACT with candidates)
  contactNotFound: "I couldn't find that contact, so nothing was done.",
  contactNotFoundNextStep:
    "Call agentlink_list_contacts to see the user's contacts, then use a contact's id or name.",
  contactAmbiguous: 'More than one contact matches that name, so nothing was done.',
  contactAmbiguousNextStep:
    'Ask the user which of these contacts they mean, then call the tool again with its id.',

  // agentlink_get_approval (06 §2.5)
  approvalPending: "The owner hasn't decided on this request yet.",
  approvalApproved:
    'The owner approved this request. Call the same tool again with the same approvalId to go ahead.',
  approvalDenied: "The owner didn't approve this request, so it won't run.",
  approvalExpired:
    'This request expired before it was used. Calling the tool again asks the owner again.',
  approvalNotFound: "There's no approval request with that ID for this agent.",
  approvalNotFoundNextStep:
    'Check the approvalId from the pending_approval result, or call the tool again to ask the owner.',
});
