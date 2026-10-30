// Advanced › Diagnostics copy (W4-SETTINGS-ADVANCED; prototype v23 "Diagnostics"; 11 §5). The report
// holds versions, statuses and counts only.
export const DIAGNOSTICS_STRINGS = {
  eyebrow: 'Advanced',
  title: 'Diagnostics',
  app: 'AgentLink',
  subtitle: 'local app on this computer',
  versionUnknown: 'version not available',
  copy: 'Copy diagnostics report',
  copied: 'Copied. No messages, keys or file names included.',
  copyFailed: "Couldn't copy. Select the table and copy it by hand.",
  colApp: 'AI app',
  colAgent: 'Agent',
  colStatus: 'Status',
  tableLabel: 'AI apps and the agents in them',
  none: 'No AI app is connected yet.',
  footnote: 'The report has versions, statuses and counts only. No messages, keys or file names.',
  reportRelays: 'Relays',
  aboutTitle: 'About AgentLink',
} as const;
