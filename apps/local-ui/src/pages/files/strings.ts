// Files page copy (11 §5: plain words; the owner's settings are "rules", never "policy"; no
// "wallet", "gas", "seed phrase" or "transaction"; DESIGN-ADJ-1 FI-3; D-99, D-119). Commands in
// backticks are typed by the owner in their own terminal and are shown exactly.
export const FILES_STRINGS = {
  foldersLabel: 'Folders your AI can send files from',
  folderMissing: "Not found on this computer. Your AI can't send from it.",
  allowFolder: 'Allow a folder',
  everyChange: 'Every change here needs your passkey or owner code.',
  emptyTitle: "Your AI can't send files yet. Allow a folder it may send from.",
  emptyPrompt: 'Send proposal.pdf to Marko.',
  loading: 'Loading…',
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  unavailable: "Your folders can't be loaded right now. Try again in a minute.",
  folderField: 'Folder',
  folderHint: 'The full path, for example ~/Documents/Shared.',
  check: 'Check folder',
  checking: 'Checking…',
  cancel: 'Cancel',
  confirmAddTitle: 'Allow your AI to send files from this folder?',
  confirmAddBody:
    'Your AI can send any file in this folder and its subfolders to your contacts. Hidden files are never sent.',
  confirmRemoveTitle: 'Stop your AI sending files from this folder?',
  confirmRemoveBody: 'Your AI can no longer send files from it. Nothing already sent changes.',
  warningsTitle: 'Before you confirm, tick each one:',
  understood: 'I understand',
  confirmAdd: 'Allow folder',
  confirmRemove: 'Stop sending',
  withPasskey: 'You confirm with your passkey.',
  useCode: 'Use owner code instead',
  ownerCode: 'Owner code',
  ownerCodeHint: 'Type it here only. Never give it to your AI.',
  sending: 'Confirming…',
  added: 'Allowed. Your AI can now send files from this folder.',
  removed: 'Removed. Your AI can no longer send files from this folder.',
  notConfirmed:
    "Your change was saved, but AgentLink couldn't confirm it, so it uses its strictest settings until your rules are set again. Run `agentlink doctor` in your own terminal.",
  rulesUnreadable:
    "Your rules couldn't be checked, so no folder can be changed. Run `agentlink policy recover` in your own terminal.",
  receiptsQuestion:
    'Before changing folders, answer one question about delivery receipts on the Rules page.',
  openRules: 'Open Rules',
  changed: 'Your rules changed in the meantime. Nothing was changed. Check the folder again.',
  expired: 'This check timed out. Nothing was changed. Check the folder again.',
  refused: "That didn't go through. Nothing was changed. Check the folder again.",
  presenceRejected: "That didn't match your passkey or owner code. Nothing was changed.",
  presenceRequired: 'Enter your owner code, or use your passkey. Nothing was changed.',
  passkeyNotUsed:
    "The passkey wasn't used. Nothing was changed. You can enter your owner code instead.",
  busy: 'Another change is being confirmed. Try again in a moment.',
  offline: "AgentLink isn't answering on this computer. Check that it's running, then try again.",
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  failed: "That didn't go through. Nothing was changed.",
  elsewhere: (typed: string): string =>
    `You typed ${typed}. It leads to the folder above, so that is the folder allowed.`,
} as const;

export const removeLabel = (path: string): string => `Stop sending from ${path}`;
export const opensAt = (path: string): string => `Opens at ${path}`;
export const waitText = (seconds: number): string =>
  `Too many tries. Wait ${String(seconds)} seconds, then try again. Nothing was changed.`;

/**
 * Every warning core's `preparePolicyEdit` can return (POLICY_EDIT_WARNING_CODES), in plain words.
 * The confirm screen lists each one the server returned, with its own tick (D-119).
 */
export const WARNING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  invites_auto: 'New contacts will be added without asking you.',
  unknown_senders_queued:
    "Messages from agents you don't know will wait for you instead of being dropped.",
  contacts_allowed_widened: 'More agents will be able to reach your AI.',
  limits_raised:
    'Some limits go up, for example how large a file can be or how many messages a contact can send.',
  retention_longer: 'Files will be kept longer.',
  allowed_folders_added: 'Your AI can send files from this folder to your contacts.',
  folder_changed: 'Where AgentLink saves files changes.',
  files_drop_allowed: 'Files may go through the encrypted drop.',
  proofs_notarize_looser:
    'Your AI will ask you less often before adding a proof, which costs credits.',
  proofs_spend_raised: 'Your AI may spend more of your credits on proofs.',
  key_disclosure_approval:
    'Your AI can ask you to reveal a document key, so others can check what a file contained.',
  proofs_chain_changed: 'Proofs will be recorded and paid on a different proof network.',
  delivery_receipts_public:
    'When a contact confirms delivery, anyone can see that it went to their agent.',
  opened_receipts_auto: 'Senders will be told automatically when you open their files.',
  commitments_looser: 'Your AI can accept commitments, with your approval.',
  commitments_allow: 'Your AI can accept commitments and firm offers without asking you.',
  auto_accept_widened: 'Your AI can accept more purchases without asking you.',
  sell_auto_accept: 'Your AI can accept sales without asking you.',
  contact_proof_rules_looser: 'Some contacts get looser proof rules.',
  contact_receipts_public: 'For some contacts, anyone can see when deliveries are confirmed.',
  contact_rule_removed_loosens:
    'Some contacts lose a stricter rule and fall back to your general rules.',
});

/** Why a folder can't be allowed or removed (04 §4, D-99; the server's fixed reasons). */
export function refusalText(reason: string, protectedFolder?: string): string {
  switch (reason) {
    case 'not_full_path':
      return 'Use the full path of a folder, for example ~/Documents/Shared.';
    case 'dot_segments':
      return 'Use the folder’s path without . or .. in it.';
    case 'not_showable':
      return "That folder's name has characters AgentLink can't show safely. Rename the folder, then try again.";
    case 'missing':
      return "That folder doesn't exist. Check the path, then try again.";
    case 'not_folder':
      return "That isn't a folder. Allow the folder that holds the file.";
    case 'too_broad':
      return "Your AI can't send from your whole computer or your whole home folder. Choose a folder inside it, such as ~/Documents/Shared.";
    case 'protected':
      return "Files in this folder can never be sent (it holds keys or AgentLink's own data). Choose another folder.";
    case 'contains_protected':
      return protectedFolder === undefined
        ? "That folder holds keys or AgentLink's own data, so it can't be allowed. Choose a narrower folder inside it."
        : `That folder contains ${protectedFolder}, which holds keys or AgentLink's own data, so it can't be allowed. Choose a narrower folder inside it that doesn't contain ${protectedFolder}.`;
    case 'hidden':
      return 'Hidden folders, and folders inside them, can’t be allowed.';
    case 'already_allowed':
      return 'That folder is already allowed. Nothing was changed.';
    case 'too_many':
      return 'You can allow at most 32 folders. Remove one first.';
    case 'not_allowed':
      return "That folder isn't one of your allowed folders.";
    default:
      return "That folder can't be allowed. Choose another folder.";
  }
}
