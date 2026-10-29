// U3-map: Live connections copy (b11 §32; 11 §5). Names and words only, never a message.
const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

export const MAP_STRINGS = {
  title: 'Live connections',
  showQuiet: 'Show quiet',
  unnamed: 'Unnamed contact',
  sending: 'Sending',
  receiving: 'Receiving',
  now: 'now',
  sendingTo: (name: string): string => `Sending to ${name}`,
  receivingFrom: (name: string): string => `Receiving from ${name}`,
  moreContacts: (n: number): string => `+${String(n)} more`,
  moreAgents: (n: number): string => `+${String(n)} more agents`,
  empty: 'No one to talk to yet.',
  addContact: 'Add contact',
  noActivity: 'Nothing has moved in the last 24 hours.',
  legend: 'A line shows people who exchanged something in the last 24 hours.',
  loadError: "Couldn't load what's moving.",
  tryAgain: 'Try again',
  loading: 'Loading live connections',
  switchToSee: 'Switch to see its contacts',
  notConnected: 'Not connected to an AI app',
  open: 'Open conversation',
  contactsCount: (n: number): string => plural(n, 'contact', 'contacts'),
  summary: (agents: number, contacts: number, talking?: { name: string; agent: string }): string =>
    `${plural(agents, 'agent', 'agents')}, ${plural(contacts, 'contact', 'contacts')}.` +
    (talking === undefined ? '' : ` ${talking.name} is talking with ${talking.agent} now.`),
  fileFrom: (name: string, agent: string): string => `${name} is sending a file to ${agent}`,
  reply: (name: string): string => `Reply from ${name}`,
  fileTo: (name: string): string => `Sending a file to ${name}`,
  messageTo: (name: string): string => `Message sent to ${name}`,
  agentBox: (label: string, apps: string): string => `${label}, ${apps}`,
  contactBox: (agent: string, name: string, word: string | undefined): string =>
    `${agent} and ${name}${word === undefined ? '' : `, ${word}`}. Open conversation`,
} as const;
