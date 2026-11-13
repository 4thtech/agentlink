// Settings › Touch ID & master code (design-1112 §3.3; 11 §5 vocabulary, D-146 words; copy proposed,
// owner confirms at merge). `sensor` is the platform's word (first-run SENSOR): Touch ID, Windows
// Hello or "your passkey". No string here carries a code, a key or another party's text.

/** First letter up, for a sensor word that starts a sentence ("your passkey" → "Your passkey"). */
export const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const TOUCH_ID_STRINGS = {
  title: (sensor: string): string => `${cap(sensor)} & master code`,
  lead: 'How you confirm that it is you. AgentLink asks before anything that changes who can act for you, spends credits or commits you. Your AI can never confirm for you.',

  // Card 1: the sensor.
  on: (sensor: string): string => `${cap(sensor)} is on`,
  onLine: 'Set up on this computer. AgentLink asks for it before every change that needs you.',
  off: (sensor: string): string => `${cap(sensor)} is off`,
  offLine: 'You confirm with your master code.',
  /** DESK051-C2: in the desktop app, its own switch below turns it on. */
  offNativeLine: 'You confirm with your master code. Turn it on with the switch below.',
  couldntCheckTitle: (sensor: string): string => `Couldn't check ${sensor}`,
  couldntCheckLine:
    "AgentLink didn't answer just now. Try again. Your master code works meanwhile.",
  tryAgain: 'Try again',
  cantTitle: (sensor: string): string => `${cap(sensor)} can't be used here`,
  test: (sensor: string): string => `Test ${sensor}`,
  testing: 'Waiting for you…',
  works: (sensor: string): string => `${cap(sensor)} works.`,
  testFailed: (sensor: string): string =>
    `${cap(sensor)} didn't work just now. Nothing was changed. Try again.`,
  testCancelled: (sensor: string): string => `${cap(sensor)} wasn't used. Nothing was changed.`,
  turnOn: (sensor: string): string => `Turn on ${sensor}`,
  turnOnIntro: (sensor: string): string =>
    `Enter your master code once, then touch ${sensor}. Your master code keeps working.`,
  turnedOn: (sensor: string): string => `${cap(sensor)} is on.`,
  notNow: 'Not now',

  // Card 2: the master code.
  codeTitle: 'Master code',
  codeLine: (sensor: string): string =>
    `Your 24-character backup for when ${sensor} can't be used. You saved it when you set up AgentLink.`,
  codeSet: 'Set',
  // REL051-R2C (R2-CLASS-03): the code made at setup or a restore was never saved.
  codeLineUnsaved: (sensor: string): string =>
    `Your 24-character backup for when ${sensor} can't be used. The one made for you wasn't saved: make a new one now.`,
  codeNotSaved: 'Not saved',
  check: 'Check my master code',
  checkLabel: 'Your master code',
  checkSubmit: 'Check',
  right: "That's the right code.",
  wrong: "That doesn't match.",
  replace: 'Replace master code',
  replaceSummary: 'Replace your master code',
  replaceIntro: (sensor: string): string =>
    `Confirm it is you with ${sensor} or your current master code. Then AgentLink shows a new code once.`,
  confirmWith: (sensor: string): string => `Confirm with ${sensor}`,
  confirmWithCode: 'Confirm with your master code',
  newTitle: 'Your new master code',
  shownOnce: 'Shown once',
  newSave:
    'Save it now, for example in your password manager, away from this computer. Never type it into a chat or let your AI see it.',
  stillWorks: 'Your current master code still works until you finish.',
  typeBack: 'Type or paste your new master code to finish',
  finish: 'Finish',
  copy: 'Copy',
  copied: 'Copied',
  cancel: 'Cancel',
  cancelled: 'Nothing was changed. Your current master code still works.',
  replaced: 'Master code replaced. The old code stops working now.',
  typeBackWrong: "That isn't the new code. Check it and try again. Your current code still works.",
  ended:
    "The new code wasn't typed back, so nothing was changed. Your current master code still works.",
  unfinished:
    'An earlier master code change didn’t finish. Run `agentlink owner change-code` in your own terminal to finish or clean it up, then try again here.',
  // IR WP-S2 M-1: the keychain may have taken the new code without confirming it.
  unconfirmed:
    "AgentLink couldn't confirm the change, so your old master code may already have stopped working. Keep both your current and your new master code, and run `agentlink owner change-code` in your own terminal: it finishes or cleans up this change.",
  cancelFailed: "Couldn't cancel just now. Your current master code still works. Try again.",
  replaceFailed:
    "That didn't work. Nothing was changed. Your current master code still works. Try again in a minute.",
  lost: 'I lost my master code',
  lostBody: (sensor: string): string =>
    `If ${sensor} still works, replace the code now. If neither works, restore from your recovery kit on this computer.`,
  lostReplace: 'Replace master code now',
  lostRestore: 'Backup & restore',

  // Card 3: what asks.
  asksTitle: (sensor: string): string => `What asks for ${sensor}`,
  asks: [
    'Approving what your AI asks for: a file, a proof, accepting terms',
    'Changing your rules, renaming or removing an ID, connecting an AI app',
    'Saving or restoring a recovery kit',
  ],
  neverAsks: 'Reading messages and looking around never asks.',

  // The info line.
  keepTitle: 'Three things to keep, and what each is for',
  keepSensor: (sensor: string): string => cap(sensor),
  keepSensorWhat: 'every day.',
  keepCode: 'Master code',
  keepCodeWhat: (sensor: string): string => `when ${sensor} can't be used.`,
  keepKit: 'Recovery kit + recovery code',
  keepKitWhat: 'when this computer is gone.',

  // Under the hood.
  hoodSensor: 'Touch ID item',
  hoodSensorOn: 'Stored for this owner',
  hoodSensorOff: 'None on this computer',
  hoodWhere: 'Wrapped key kept in',
  hoodKeychain: 'Keychain',

  failed: "That didn't work. Nothing was changed. Try again in a minute.",
} as const;
