// Shell copy (11 §5: no "wallet", "gas", "seed phrase" or "transaction"). Page copy lives with each
// page; only the shell and the shared stub state are here.
export const SHELL_STRINGS = {
  appName: 'AgentLink',
  navLabel: 'Main',
  notAvailableTitle: "This page isn't available yet.",
  notAvailableHint: 'It arrives in an update. Nothing is lost while you wait.',
  notFoundTitle: "This page isn't here.",
  notFoundHint: 'Pick a page from the menu.',
} as const;

export const PAGE_TITLES = {
  firstRun: 'Set up AgentLink',
  approvals: 'Approvals',
  approve: 'Approval',
  activity: 'Activity',
  contacts: 'Contacts',
  files: 'Files',
  storage: 'Storage',
  proofs: 'Proofs & credits',
  rules: 'Rules',
  backup: 'Backup',
  advanced: 'Advanced',
} as const;
