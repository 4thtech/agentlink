// Advanced › Message network copy (W4-SETTINGS-ADVANCED; 11 §5). The default page shows counts and
// times only; the servers' names show only under the hood (network/view.tsx, NET-UI-A).
import { NETWORK_STRINGS } from './network/strings.js';

export const ADVANCED_STRINGS = {
  title: NETWORK_STRINGS.title,
  intro: NETWORK_STRINGS.intro,
  relays: 'Relays',
  relayCount: (connected: number, total: number): string =>
    `${String(connected)} of ${String(total)} connected`,
  relaysWorking: 'Working',
  /** REL051-CF2: shown while none of the relays can be reached from this computer. */
  unreachable:
    "Can't reach the message network from this computer. Messages wait and send when it's back. A school or office network may block it.",
  noRelays: 'No relays reported yet',
  network: 'Network',
  networkAuto: 'Picked automatically',
  lastSync: 'Last checked',
  /** REL051-CF2: before the first relay check from this computer has finished. */
  checking: 'Checking the connection…',
  never: 'Not yet',
  unknown: "AgentLink didn't answer. Check that your AI app is open, then reload.",
  hoodRelays: 'Relays connected',
  hoodRelaysKnown: 'Relays known',
  hoodLastUpdateAt: 'Last checked (UTC)',
} as const;
