// Advanced › Relays & network copy (W4-SETTINGS-ADVANCED; 11 §5). Counts and times only: the page
// never shows where a relay is, and has no response time until the app measures one.
export const ADVANCED_STRINGS = {
  title: 'Relays & network',
  intro: 'How your encrypted messages travel. Relays only ever see them scrambled.',
  relays: 'Relays',
  relayCount: (connected: number, total: number): string =>
    `${String(connected)} of ${String(total)} connected`,
  noRelays: 'No relays reported yet',
  network: 'Network',
  networkAuto: 'Picked automatically',
  lastSync: 'Last update',
  never: 'Not yet',
  unknown: "AgentLink didn't answer. Check that your AI app is open, then reload.",
  hoodRelays: 'Relays connected',
} as const;
