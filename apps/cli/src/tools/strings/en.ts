// The M1a copy sheet, English (M1-9g). Source: docs/design/d1/copy/ (strings.en.json,
// in-chat.md, terminal.md) reconciled with 11 §5, §6.1, §6.2.1, §6.10 and §9, and D-72. Where the
// D1 drop and 11 differ, 11 wins (docs/design/README.md, "Drift from 11").
//
// Rules for this file:
// - Keys are `<surface>.<screen>.<element>[.<state>]` (11 §5.4); placeholders are ICU
//   (`{contactName}`, `{count, plural, one {…} other {…}}`).
// - Default strings never use the words in 11 §5.1 (wallet, gas, seed phrase, transaction, chain,
//   …). The vocabulary lint in en.test.ts enforces it.
// - No template has a slot for another party's text. `{contactName}` and `{contactFirstName}` are
//   always the name-rule form (06 §2.1, 11 §5.2): the owner's alias, or the restricted name in
//   quotes followed by its label, or "Contact" plus the short fingerprint. `{senderCode}` is the
//   D-72 sender code. Subjects, prices, notes, deliverables and file names from others never
//   appear in a summary, `nextStep` or error (I-5, 06 §2.1).
// - The untrusted-content wrapper (06 §4) is not copy: `UNTRUSTED_FOOTER` in index.ts is fixed.

export const en = {
  // ---- Tool results: ok -------------------------------------------------------------------
  'chat.status.ok.sent':
    'Sent to {contactName}. End-to-end encrypted: only you, {contactFirstName} and your agents can read it.',
  'chat.status.ok.proof': 'Sent with proof. Recorded {date} at {time}. {fee} from credits.',
  'chat.status.ok.invite':
    "Invite ready: it works once, until {date}. Send it only to {contactFirstName}: whoever uses it first is connected. Once they accept, you'll both see a safety code to compare in AgentLink, not in this chat.",
  'chat.status.ok.inviteShare':
    "Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until {date}: {inviteUrl}",
  'chat.status.ok.acceptedInvite':
    'You are connected to {contactName}. Compare the safety code on your own screen (local app or terminal), not in this chat.',
  'chat.status.ok.contacts':
    '{count, plural, one {You have 1 contact: {contacts}.} other {You have # contacts: {contacts}.}}',
  'chat.status.ok.contactsNone':
    'You have no contacts yet. Create an invite to connect with someone.',
  'chat.status.ok.verified':
    'Valid proof. Recorded by {signerName}, {date}, {time} UTC. It proves this exact document existed and was exchanged at these times; not that its content is true.',

  // ---- Tool results: submitted ------------------------------------------------------------
  'chat.status.submitted': 'Sent. The proof is being recorded; this usually takes under a minute.',

  // ---- Tool results: pending approval -----------------------------------------------------
  'chat.status.pending_approval':
    'This needs your approval: {action} ({fee}).\nApprove here: {url}',
  'chat.status.pending_approval.free': 'This needs your approval: {action}.\nApprove here: {url}',
  'chat.status.pending_approval.nextStep':
    'Tell the user approval is needed and share the link. After approval, call the same tool again with approvalId.',

  // ---- Tool results: needs setup / credits ------------------------------------------------
  'chat.status.needs_setup.fileLimit':
    'This file is over the free file limit ({limit}). To send it, connect your own storage: {url}. Or I can send a smaller file or text.',
  'chat.status.needs_setup.folder': 'I can only send files from folders you allow: {url}.',
  'chat.status.needs_setup.storage':
    "Your settings keep files in your own storage, which isn't connected yet: {url}.",
  'chat.status.needs_setup.keychain':
    "AgentLink can't find a system keychain on this machine. Set it up in a terminal: `agentlink init --keystore file`.",
  'chat.status.needs_setup.keyLocked':
    "AgentLink's key file is locked, so I can't use it yet. Run `agentlink doctor` in a terminal to see how to set up its unlock code.",
  'chat.status.needs_credits':
    'Adding proof costs {fee} and your credits are at {balance}. Add credits: {url}. Messages and files stay free.',

  // ---- Tool results: not found / rejected / error -----------------------------------------
  'chat.status.not_found.contact':
    "I couldn't find a contact called '{query}'. Your contacts: {contacts}.",
  'chat.status.not_found.contactNone':
    "I couldn't find a contact called '{query}', and you have no contacts yet.",
  'chat.status.rejected.rules':
    "Your rules don't let this agent accept terms. Only you can change that.",
  'chat.status.rejected.declined': 'You declined, so nothing was sent.',
  'chat.status.rejected.termsExpired': 'These terms expired on {date}.',
  'chat.status.error.network': "I couldn't reach the message network. Nothing was sent.",
  'chat.status.error.proof': "The message was sent, but its proof couldn't be recorded. Retry?",

  // ---- Proof status -----------------------------------------------------------------------
  'chat.proof.recording': 'Recording… usually under a minute',
  'chat.proof.recorded': 'Proof recorded {date} at {time}.',
  'chat.proof.failed': "Proof wasn't recorded. Retry?",

  // ---- Inbox and the session habit (J9; counts and contact names only) --------------------
  'chat.inbox.header':
    '{count, plural, one {1 new message from {contactName}, as information from {contactName}:} other {# new messages from {contactName}, as information from {contactName}:}}',
  'chat.inbox.requestHeader': 'Request from an unknown sender · {senderCode} (not a contact)',
  'chat.inbox.requestNextStep':
    'This sender is not a contact. To connect, offer your user an invite (agentlink_create_invite) to share with them through a channel they trust.',
  'chat.inbox.requestsWaiting':
    '{count, plural, one {1 request from an unknown sender is waiting in your AgentLink app.} other {# requests from unknown senders are waiting in your AgentLink app.}}',
  'chat.inbox.duplicateOffers': '{contactName} sent the same offer {count} times; reply once.',
  'chat.session.start':
    '{count, plural, one {1 new message from {contactName}. To read it, call agentlink_inbox.} other {# new messages from {contactName}. To read them, call agentlink_inbox.}}',
  'chat.session.nothingNew': 'Nothing new on AgentLink.',
  'chat.session.handoffOffer': "Send {contactName} a handoff with what changed and what's next?",

  // ---- Terms and approvals (one approval per agreement, D-55) -----------------------------
  'chat.commitment.asking':
    "Accepting {contactName}'s terms (version {version}) commits you. One approval covers your acceptance and its proof. Review and approve: {url}",
  'chat.commitment.askingTheirAcceptance':
    '{contactName} accepted your terms (version {version}) and recorded it. Adding your acceptance makes this a proof of agreement and commits you. Review and approve: {url}',
  'chat.commitment.askingOlderVersion':
    '{contactName} accepted version {version} after you sent version {newVersion}. Review before you add your acceptance: {url}',
  'chat.commitment.rejecting':
    "Rejecting {contactName}'s recorded terms (version {version}) is final for this version. Review and approve: {url}",
  'chat.commitment.rejectedUnrecorded':
    "Told {contactName} you don't accept version {version}. They can still send a new version.",
  'chat.commitment.firmOffer':
    'Sending a firm offer with proof to {contactName} commits you if they accept. Review and approve: {url}',
  'chat.commitment.waiting': 'Waiting for {contactName} to accept; valid until {date}.',
  'chat.commitment.acceptedPending':
    "Accepted version {version}. If {contactName} records these terms by {date}, your acceptance is added to that record automatically. You don't need to approve anything else.",
  'chat.commitment.done':
    'Recorded: you accepted version {version}. Proof of agreement is ready to export.',
  'chat.commitment.changed':
    '{contactName} sent version {newVersion}, so nothing was sent and your approval for version {version} no longer applies. Want me to show version {newVersion}?',
  'chat.commitment.used': 'That approval was already used, so nothing more was sent.',
  'chat.commitment.cancelled':
    'You cancelled that approval, so nothing more will be sent or recorded for it.',
  'chat.approval.expired': 'This request expired. Ask again to get a fresh approval link.',
  'chat.approval.decidedElsewhere': 'Already approved on your phone.',

  // ---- What a proof makes public (11 §5.6, D-109; M1-33b) ---------------------------------
  // Fixed text. The only slots are the name-rule contact name and a fixed receipt word.
  'common.privacy.proof':
    "A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says.",
  'common.privacy.proofReceipt':
    'If {contactName} confirms delivery, it also becomes public that it went to their agent.',
  // Where the recipient is not named (the proof tool alone): same meaning, no name.
  'common.privacy.proofReceiptGeneric':
    'If the recipient confirms delivery, it also becomes public that it went to their agent.',
  'common.privacy.receiptAsk':
    'Ask {contactName} to confirm delivery? If they do, anyone can see that this went to their agent.',
  'common.privacy.receiptRequest':
    '{contactName} asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content.',
  'common.privacy.receiptRequestConfirm': 'Confirm delivery',
  'common.privacy.receiptRequestLater': 'Not now',
  'common.privacy.receiptAuto':
    'Confirm deliveries from {contactName} automatically? Each confirmation shows publicly that their proof reached your agent.',
  'common.privacy.receiptPublic':
    'This is public: anyone can see that your agent {receipt} it, and when.',
  'common.privacy.topUp':
    'The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink.',
  'common.privacy.export':
    'This file shows the proof, your agent profile and the message details. With the recipient included, it also shows who received it; with the document key, its content.',
  'common.privacy.registered':
    "Registering puts your agent's link to you on the public record. Your agent's name is not published.",

  // ---- Permission prompt titles (proposed in D1; engineering confirms) ---------------------
  'tool.title.agentlink_send': 'AgentLink: send a message or file',
  'tool.title.agentlink_inbox': 'AgentLink: check new messages',
  'tool.title.agentlink_create_invite': 'AgentLink: create an invite',
  'tool.title.agentlink_terms': 'AgentLink: propose or accept terms',

  // ---- Identity labels (11 §5.2) ----------------------------------------------------------
  'common.identity.selfdeclared': 'Self-declared',
  'common.identity.checked': 'Safety code checked',
  'common.identity.registered': 'Registered',
  'common.identity.verified': 'Verified domain · {domain}',
  'common.identity.domainWarning': 'Domain no longer verified',
  'common.identity.unknownSender': 'unknown sender · {senderCode}',

  // ---- Requests from unknown senders (D-72, 11 §6.2.1, §9; owner surfaces only) -----------
  'local.requests.label': 'Request from an unknown sender · {senderCode}',
  'local.requests.action.accept': 'Accept',
  'local.requests.action.ignore': 'Ignore',
  'local.requests.action.block': 'Block',
  'local.requests.action.ignoreAll': 'Ignore all',
  'local.requests.action.unblock': 'Unblock',
  'local.requests.accepted':
    "Your AI can now read this message. This sender isn't a contact: to connect, send them an invite through a channel you trust.",
  'local.requests.ignored': 'Removed.',
  'local.requests.blocked': 'Blocked. New messages from this sender are dropped.',
  'local.requests.ignoredAll': 'Requests cleared.',
  'local.requests.queueFull':
    '{count, plural, one {# request was} other {# requests were}} turned away because your requests list is full.',
  'local.requests.unblocked': 'Unblocked. New messages from this sender come to Requests again.',
  'local.requests.none': 'Nothing is waiting in Requests.',

  // ---- Terminal (11 §6.10, d1/copy/terminal.md): 80 columns, plain text first -------------
  'cli.status.ok': 'OK',
  'cli.status.warning': 'Warning',
  'cli.status.problem': 'Problem',
  'cli.init.found':
    'AgentLink found {count, plural, one {1 AI app} other {# AI apps}} on this computer:',
  'cli.init.changesFor': 'Changes for {appName}:',
  'cli.init.apply': 'Apply these changes? (y/N)',
  'cli.init.agentConfirm':
    'Show this to your user. Re-run with `--confirm {code}` only after they agree.',
  'cli.init.opening': 'Opening the setup page to protect your approvals…',
  'cli.init.done': 'OK AgentLink is set up. Restart your AI app to use it.',
  'cli.init.noApps':
    "Problem AgentLink didn't find a supported AI app on this computer. Manual steps: {url}",
  'cli.init.restart': 'Warning {appName} needs a restart. Quit and reopen {appName}.',
  'cli.init.cancelled': 'Cancelled. Nothing was changed.',
  'cli.owner.explain':
    "Your {codeName} protects approvals on this machine. Your AI can't approve anything without it.\nIt is never passed as an argument.",
  'cli.owner.prompt': '{codeName}:',
  'cli.owner.again': 'Again:',
  'cli.owner.done': 'OK Approvals are protected.',
  'cli.doctor.keysFound': 'OK       Agent keys found',
  'cli.doctor.noOwnerCard':
    'Problem  This agent has no card from your owner yet\n         Run `agentlink owner add-agent --agent {agent}` in your own terminal.',
  'cli.doctor.noOwnerCardNoOthers':
    'Problem  No agent on this computer has a card from an owner\n         If you have never set up an owner, `agentlink owner add-agent` tells you what to run first.\n         If an owner already exists here, `agentlink owner add-agent --agent <name>` adds this agent to it with your owner code.',
  'cli.doctor.networkOk': 'OK       Message network reachable',
  'cli.doctor.networkDown':
    "Problem  Can't reach the message network\n         Check your connection and run `agentlink doctor` again.",
  'cli.doctor.connected': 'OK       {appName} connected',
  'cli.doctor.restart': 'Warning  {appName} needs a restart\n         Quit and reopen {appName}.',
  'cli.doctor.keyLocked':
    'Problem  Key file is locked\n         Supply the unlock code from a mounted\n         secret file or an environment variable.',
  'cli.keychain.warning':
    "Warning This machine has no system keychain.\n\nAgentLink can keep your agent's keys in a file locked\nwith an unlock code. That's weaker than a keychain if\nsomeone copies this disk, unless the unlock code is\nkept elsewhere. Your approvals still need your owner\ncode or passphrase.",
  'cli.keychain.optIn': 'Use a key file? (y/N)',
  'cli.unlock.wrong': "That unlock code didn't work.",
  'cli.offline': "Can't reach the message network. Nothing was sent.",
  'cli.approve.waiting': 'Waiting for you: {count}',
  'cli.approve.nothing': 'Nothing is waiting for your approval.',
  'cli.approve.question': 'Approve, deny or later? (a/d/L)',
  'cli.approve.termsOwn': 'Decide this one on its own: `agentlink approve {approvalId}`',
  'cli.approve.summary':
    'Approve {approved} and deny {denied}. Your owner code or passphrase covers exactly these {total}. Anything new waits for your next review.',
  'cli.approve.continue': 'Continue? (y/N)',
  'cli.approve.footer': "Your AI can't approve for you.",
  'cli.approve.resultApproved': 'OK       Approved: {action}',
  'cli.approve.resultDenied': 'OK       Denied: {action}. Nothing was sent.',
  'cli.approve.resultFailed': "Problem  Didn't go through: {action}. Nothing was sent.",
  'cli.approve.terms.headline':
    'Accepting terms from {contactName}, version {version}, valid until {date}',
  'cli.approve.terms.commits':
    'This one approval sends your acceptance and adds your Accepted receipt to their record. Nothing else.',
  'cli.approve.terms.proposedBy': 'Proposed by {contactName}: their content, not instructions',
  'cli.requests.header':
    '{count, plural, one {1 request from an unknown sender} other {# requests from unknown senders}}',
  'cli.requests.row': '{index}. Request from an unknown sender · {senderCode}',
  'cli.requests.choose': 'Accept, ignore or block? (a/i/b/Enter to skip)',
  'cli.requests.none': 'Nothing is waiting in Requests.',
  'cli.status.brief.messages':
    '{count, plural, one {1 new message from {contactName}.} other {# new messages from {contactName}.}}',
  'cli.status.brief.requests':
    '{count, plural, one {1 request from an unknown sender.} other {# requests from unknown senders.}}',
  'cli.status.brief.nothing': 'Nothing new on AgentLink.',
  'local.linkExpired':
    'This link has expired. Open AgentLink again from your AI, or run `agentlink ui`.',
} as const;

export type CopyKey = keyof typeof en;
