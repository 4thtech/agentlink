// Activity pulse copy (UX2-f2; b11 §24.5; 11 §5: plain words, "Active now", never "Online").
export const PULSE_STRINGS = {
  activeNow: 'Active now',
  today: 'Today',
  quiet: 'Quiet',
  sortLabel: 'Sort',
  recent: 'Recent',
  mostActive: 'Most active',
  /** The pulse's one-image name: the count in words. */
  summary: (n: number): string =>
    n === 0
      ? 'No messages in the last 24 hours'
      : n === 1
        ? '1 message in the last 24 hours'
        : `${String(n)} messages in the last 24 hours`,
} as const;
