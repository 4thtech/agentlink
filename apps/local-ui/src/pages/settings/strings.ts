// Settings copy (design-1112 §3.1; 11 §5: plain words, no "wallet", "gas", "seed phrase" or
// "transaction"). Each row has one line and, when it is known, a state on the right. A line that
// would need a value the app could not read falls back to plain words (nothing is made up).
import { sensorWord } from '../../presence-word.js';
export const SETTINGS_STRINGS = {
  title: 'Settings',
  back: 'Settings',
  navLabel: 'Settings pages',
  groups: { safety: 'Safety', ai: 'Your AI', app: 'This app' },
  backup: {
    title: 'Backup & restore',
    fallback: 'Save a recovery kit, or bring your IDs back from one',
    none: 'No recovery kit yet',
    saved: (date: string, names: string): string =>
      names === ''
        ? `Last recovery kit saved ${date}`
        : `Last recovery kit saved ${date} · covers ${names}`,
    upToDate: 'Up to date',
    outOfDate: 'Out of date',
    notBackedUp: 'Not backed up',
    notFinished: 'Not finished',
  },
  touchId: {
    get title(): string {
      return `${sensorWord()} & master code`;
    },
    line: 'How you confirm that it is you. Your AI can never do this for you.',
    on: (sensor: string): string => `${sensor} on`,
    masterOnly: 'Master code only',
  },
  rules: {
    title: 'Rules',
    fallback: 'What your AI may do without asking',
    line: (asks: number, total: number): string =>
      `What your AI may do without asking. Asks you first for ${String(asks)} of ${String(total)} things.`,
  },
  apps: {
    title: 'AI apps',
    none: 'No AI app connected yet',
    fallback: 'The AI apps that can use AgentLink',
    line: (names: readonly string[]): string => {
      const last = names[names.length - 1] ?? '';
      if (names.length === 1) return `${last} is connected`;
      return `${names.slice(0, -1).join(', ')} and ${last} are connected`;
    },
    state: (n: number): string => `${String(n)} connected`,
  },
  files: {
    title: 'Files',
    fallback: 'Folders your AI may send from, and where received files go',
    line: (n: number): string =>
      `Your AI may send from ${String(n)} ${n === 1 ? 'folder' : 'folders'}.`,
  },
  appearance: {
    title: 'Appearance',
    line: 'Theme, motion and the Under the hood view',
    system: 'Match my computer',
    light: 'Light',
    dark: 'Dark',
  },
  proofs: {
    title: 'Proofs & credits',
    fallback: 'Messages and files are free. A public proof costs a small fee.',
    line: (price: string): string =>
      `Messages and files are free. A public proof costs about ${price}.`,
    state: (balance: string, n: number): string =>
      `${balance} · about ${String(n)} ${n === 1 ? 'proof' : 'proofs'}`,
  },
  advanced: {
    title: 'Advanced',
    line: 'Network, diagnostics and the activity log. Nothing here needs changing.',
    working: 'All working',
    reconnecting: 'Reconnecting…',
  },
  notice: {
    noKitTitle: 'You have no recovery kit.',
    noKit: 'If this computer is lost, your IDs, people and messages are gone.',
    noKitAction: 'Save a recovery kit',
    staleTitle: (ids: number, people: number): string => {
      const parts: string[] = [];
      if (ids > 0) parts.push(`${String(ids)} ${ids === 1 ? 'ID' : 'IDs'}`);
      if (people > 0) parts.push(`${String(people)} ${people === 1 ? 'person' : 'people'}`);
      return `Your recovery kit is missing ${parts.join(' and ')}.`;
    },
    stale: (date: string): string =>
      `Saved ${date}. If this computer were lost today, they would not come back.`,
    staleAction: 'Save a new kit',
  },
  footer: {
    version: (version: string): string => `AgentLink ${version}`,
  },
  search: {
    label: 'Find a setting',
    empty: 'No setting matches that.',
  },
} as const;
