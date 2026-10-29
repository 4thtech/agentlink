// The join screen's copy (U3-invite; b11 §33.2, §33.3; 11 §5). `{name}` is always the name-rule
// output, rendered as React text; `{fingerprint}` the short owner fingerprint; `{agent}` the open
// agent's label. No "wallet", "key", "address", "transaction", "relay" or "harness".
import type { Platform } from '../first-run/strings.js';
import { SENSOR } from '../first-run/strings.js';

export const JOIN_STRINGS = {
  title: (name: string): string => `Accept ${name}'s invite?`,
  check: (name: string, fingerprint: string): string => `Check it's ${name}: ${fingerprint}`,
  selfDeclared: 'Self-declared',
  fingerprintLabel: 'FINGERPRINT',
  until: (date: string): string => `until ${date}`,
  isThisWho: 'Is this who you expected?',
  forAgent: (agent: string): string => `For: ${agent}`,
  afterConnect: (name: string): string =>
    `After you connect, compare the safety code with ${name}.`,
  acceptWith: (platform: Platform): string => `Accept with ${SENSOR[platform]}`,
  acceptWithCode: 'Accept with your backup code',
  notNow: 'Not now',
  connecting: (name: string): string => `Connecting to ${name}…`,
  waitingForThem: (name: string): string => `Waiting for ${name}'s agent to answer.`,
  tenMinutes: (name: string): string =>
    `If nothing happens, the invite may have been used already or ${name}'s AI app isn't running. Ask ${name} to check, or for a new invite.`,
  goHome: 'Go to Home',
  connected: (name: string): string => `Connected with ${name}.`,
  compare: (name: string): string => `Compare the safety code with ${name}`,
  alreadyAccepted: 'You already accepted this invite.',
  open: (name: string): string => `Open ${name}`,
  own: 'This is your own invite.',
  expired: (name: string): string => `This invite has expired. Ask ${name} for a new one.`,
  rulesDeny: "Your rules don't allow new contacts.",
  notAccepted: 'Not accepted yet. Try again.',
  changed: 'The invite on this screen changed. Check who it is again.',
  none: 'There is no invite waiting here.',
  offline: "Couldn't reach AgentLink on this computer. Try again in a moment.",
  /** The owner statement before the gesture (04 §3.6 Accept step 2). */
  statement: (name: string, fingerprint: string, agent: string): string =>
    `Accept an invite from ${name} (Self-declared, owner ${fingerprint}) for ${agent}`,
  regionLabel: 'Who invites you',
} as const;
