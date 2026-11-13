// Settings > Updates copy (DESK051-UPD; 11 §5: plain words, no "wallet", "gas", "seed phrase" or
// "transaction"). Short steps; nothing about how the check works.
export const UPDATES_STRINGS = {
  title: 'Updates',
  lead: 'Keep AgentLink up to date to get the latest fixes and features.',
  version: (v: string): string => `You have AgentLink ${v}.`,
  check: 'Check for updates',
  checking: 'Checking…',
  idle: 'AgentLink looks for a newer version once a day.',
  current: 'AgentLink is up to date.',
  ready: (v: string): string => `AgentLink ${v} is ready`,
  readyLead: 'Download it and replace the AgentLink you have now.',
  download: 'Download update',
  stepsLabel: 'How to update',
  macSteps: [
    'Open the file you downloaded.',
    'Quit AgentLink: click its icon in the menu bar and choose Quit AgentLink.',
    'Drag AgentLink to the Applications folder and choose Replace.',
    'Open AgentLink again.',
  ],
  otherSteps: [
    'On the page that opens, download AgentLink for your computer.',
    'Open the file and follow its steps.',
    'Open AgentLink again.',
  ],
  keeps: 'Your IDs, people and messages stay as they are.',
  failed: 'Couldn’t check for updates just now. Try again later.',
  offline: 'You’re offline. Connect to the internet, then check again.',
  off: 'Checking for updates is turned off on this computer.',
  loading: 'Reading your version…',
  unreadable: 'Couldn’t read this just now.',
  retry: 'Try again',
} as const;
