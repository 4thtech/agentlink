// Fixed handler text that the M1-9g copy sheet has no key for yet (M1-9c). Handlers use the copy
// sheet (strings/) where a key exists; these sentences are the rest. None has a slot: nothing here is
// ever built from a value (I-5), and every sentence passes the 11 §5.1 vocabulary lint
// (text.test.ts). Moving them into the copy sheet is M1-9g's (owner of strings/ after M1-9o/p/q).
// 06 §6 local agent name (tools/ may not import the runtime; same pattern as runtime/agent-name.ts).
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The command that works after the documented install (06 §1: tools/ cannot import the runtime, so
 * this is the `npx` form; the runtime passes its own `cliPrefix()` where it knows a global install).
 */
const DEFAULT_PREFIX = 'npx -y @4thtech-io/agentlink';

export const TOOL_TEXT = Object.freeze({
  // agentlink_status and the not-set-up server
  // M1-9u, M1-36a: the agent is open (so `init` ran) but the owner has not set it up. Slots: the
  // command to run (built by `noOwnerCard` from a checked agent name and the command prefix).
  noOwnerCard:
    "AgentLink isn't protected yet. In a terminal you opened yourself, run `{command}`. Your AI can't do this for you.",
  noOwnerCardAgent:
    "This agent isn't set up with your owner yet. In a terminal you opened yourself, run `{command}`. Your AI can't do this for you.",
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
    'Ask the user which of these contacts they mean, then call the tool again with its id. If two contacts share a name, the user can rename or remove one in their own terminal with `' +
    DEFAULT_PREFIX +
    ' contacts rename` or `' +
    DEFAULT_PREFIX +
    ' contacts remove`.',

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
 * The `needs_setup` text for an open agent that is not set up with an owner (M1-9u, M1-36a; 04
 * §2.8). `owner init` only when the machine is known to have no owner; otherwise `owner
 * add-agent`. The name goes into the text only after the 06 §6 name check; otherwise the
 * placeholder `<name>` is shown.
 */
export function noOwnerCard(
  agentName?: string,
  options: { prefix?: string; ownerExists?: boolean } = {},
): { summary: string; nextStep: string } {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const agent = agentName !== undefined && AGENT_NAME.test(agentName) ? agentName : '<name>';
  // `owner init` only when this machine is known to have no owner; unknown keeps the add-agent step.
  const withOwner = options.ownerExists !== false;
  const agentFlag = agent === 'default' ? '' : ` --agent ${agent}`;
  const command = withOwner
    ? `${prefix} owner add-agent --agent ${agent}`
    : `${prefix} owner init${agentFlag}`;
  return {
    summary: (withOwner ? TOOL_TEXT.noOwnerCardAgent : TOOL_TEXT.noOwnerCard).replace(
      '{command}',
      command,
    ),
    nextStep: TOOL_TEXT.noOwnerCardNextStep,
  };
}
