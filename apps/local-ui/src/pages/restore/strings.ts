// Restore wizard copy (UX1113-R3; D-147; design-1112 spec §6.4 to §6.6, 11 §5). Plain words: no key, hash,
// wallet, gas, chain or transaction, and no terminal command in a Simple-layer sentence. "Recovery code"
// is the 24 characters of a kit; "master code" is the code that confirms things on this computer.
import type { RestoreProblem } from './api.js';

export const STEP_IDS = ['kit', 'code', 'review', 'protect'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const WIZARD = {
  brand: 'AgentLink',
  progressLabel: 'Restore progress',
  cancel: 'Cancel',
  eyebrow: 'Restore from a recovery kit',
  eyebrowCheck: 'Check my kit',
  stepLabel: (n: number, name: string): string => `Step ${n} of 4 · ${name}`,
  stepLabelCheck: (n: number, name: string): string => `Step ${n} of 2 · ${name}`,
  stepNames: {
    kit: 'Your kit file',
    code: 'Your recovery code',
    review: 'What comes back',
    protect: 'Protect and reconnect',
  } as const,
  back: 'Back',
} as const;

export const KIT = {
  title: 'Choose your kit file',
  finishTitle: 'Finish restoring: choose your kit again',
  finishLead:
    'A restore on this computer did not finish. Choose your kit again and AgentLink will complete it. Nothing already restored is overwritten.',
  lead: 'It is the file AgentLink saved when you backed up. Its name starts with ',
  leadName: 'agentlink-recovery-kit',
  found: 'Found on this computer',
  foundLine: (folder: string, saved: string, size: string): string =>
    `In ${folder} · saved ${saved} · ${size}`,
  folders: { downloads: 'Downloads', desktop: 'Desktop', home: 'your home folder' } as const,
  looking: 'Looking for your kit file…',
  dropTitle: 'Or drop a kit file here',
  dropHint: 'From a USB stick or your cloud drive',
  choose: 'Choose a file…',
  picked: (name: string): string => `Chosen: ${name}`,
  assurance:
    'The file is opened on this computer only. Nothing is uploaded, and your AI is not part of this.',
  next: 'Continue',
  working: 'Checking the file…',
  noFile: "I don't have my kit file",
  noFileBody:
    "Without the kit file your old IDs can't be brought back. You can start fresh: your people will need new invites.",
  startFresh: 'Start fresh',
  needsFile: 'Choose a kit file first.',
  /** Public-header problems, before any code is asked. */
  notAKit: "This isn't an AgentLink recovery kit.",
  newer: 'This kit was made by a newer AgentLink. Update AgentLink, then try again.',
  otherOwner:
    "This kit belongs to a different owner than the one on this computer. It can't be restored here.",
  otherOwnerHint: 'Restore it on another computer or another user account of this computer.',
} as const;

export const PRESENCE = {
  title: "Confirm it's you to restore here",
  lead: (sensor: string): string =>
    `This computer already has an owner. Confirm with ${sensor} or your master code.`,
  usePasskey: (sensor: string): string => `Confirm with ${sensor}`,
  codeLabel: 'Master code',
  useCode: 'Confirm with my master code',
  useCodeInstead: 'Use your master code instead',
  rejected: "That didn't confirm it's you. Nothing was changed.",
  warning: 'Never give your master code to your AI.',
} as const;

export const CODE = {
  title: 'Type your recovery code',
  lead: (date: string): string =>
    `The 24 characters you wrote down when you saved this kit on ${date}. Not your master code.`,
  leadNoDate: 'The 24 characters you wrote down when you saved this kit. Not your master code.',
  groupLabel: (n: number): string => `Recovery code, group ${n} of 6`,
  groupsLabel: 'Recovery code',
  hint: 'Capital or small letters both work. You can paste the whole code.',
  warnTitle: 'Type it yourself.',
  warn: 'Never give this code to your AI, and never paste it into a chat. AgentLink will never ask for it anywhere but on this screen.',
  assurance: 'The code is checked on this computer and is never stored or sent anywhere.',
  open: 'Open my kit',
  opening: 'Opening your kit…',
  lost: 'I lost my recovery code',
  lostBody:
    "Each kit has its own code and it can't be reset. If your old computer still works, save a new kit there. Otherwise you can start fresh.",
  startFresh: 'Start fresh',
  incomplete: 'Type all 24 characters.',
  wrong: "That code doesn't open this kit. Check each group and try again. Nothing was changed.",
  wait: (seconds: number): string => `Too many wrong tries. Wait ${seconds} seconds.`,
  damaged: 'This kit file is damaged or incomplete. Try another copy of it. Nothing was changed.',
} as const;

export const CHECKED = {
  title: 'This kit opens.',
  body: (date: string, names: string, people: number, last: string | undefined): string =>
    `Saved ${date}. It holds ${names}, with ${people} ${people === 1 ? 'person' : 'people'}${
      last === undefined ? '' : ` and messages up to ${last}`
    }.`,
  bodyNone: (date: string): string => `Saved ${date}. It holds no IDs yet.`,
  note: 'Nothing was written to this computer.',
  done: 'Done',
  another: 'Check another kit',
} as const;

export const REVIEW = {
  eyebrow: (date: string): string => `Your kit opened · saved ${date}`,
  title: 'Here is what comes back',
  lead: 'Nothing has changed on this computer yet. IDs that are already here are never overwritten.',
  listLabel: 'IDs in this kit',
  pick: (name: string): string => `Restore ${name}`,
  newLine: (people: number, last: string | undefined): string =>
    `${people} ${people === 1 ? 'person' : 'people'} · ${
      last === undefined ? 'no messages in this kit' : `messages up to ${last}`
    } · rules and credits`,
  newLineIdentity: (people: number): string =>
    `${people} ${people === 1 ? 'person' : 'people'} · rules and credits · no messages in this kit`,
  takenLine: (people: number, name: string): string =>
    `${people === 0 ? 'No people yet' : `${people} ${people === 1 ? 'person' : 'people'}`} · this computer already has an ID called ${name}, so it comes back as `,
  hereLine: 'Already on this computer. Skipped, nothing is overwritten.',
  removedLine: (date: string): string =>
    `You removed this ID${date === '' ? '' : ` on ${date}`} and your people were told. A removed ID can't come back.`,
  willBeRestored: 'Will be restored',
  alreadyHere: 'Already here',
  removedEarlier: 'Removed earlier',
  changeName: 'Change name',
  nameLabel: (name: string): string => `New name for ${name}`,
  nameSave: 'Use this name',
  nameInvalid: 'Use 1 to 32 letters, numbers or dashes, starting with a letter.',
  nameClash: 'Another ID here or in this kit has that name.',
  comesBack: 'Comes back',
  /** UX1113-R1-LABEL: the kit names an ID by its folder; the label is inside, read after restore. */
  nameHint: 'Its name comes back with it',
  comes: ['People and messages', 'Rules, proofs and credits'] as const,
  comesSince: (date: string): string =>
    `Messages sent to you since ${date} arrive in a minute or two`,
  doNext: 'You do next',
  next: (sensor: string, newOwner: boolean): readonly string[] => [
    ...(newOwner ? [`Turn on ${sensor} and save a new master code (next step)`] : []),
    'Reconnect your AI apps (one click each)',
    'Copy your Files folder yourself, if you want old files',
  ],
  restore: (n: number): string => `Restore ${n} ${n === 1 ? 'ID' : 'IDs'}`,
  nothing: 'Everything in this kit is already on this computer. Nothing to restore.',
  done: 'Done',
  progress: (name: string, i: number, n: number): string => `Restoring ${name}… ${i} of ${n}`,
  restoring: 'Restoring…',
  /** An ID the read-back refused: not restored, nothing of it kept. */
  notRestored: (name: string): string =>
    `${name} was not restored. Nothing of it was kept. Your other IDs are fine.`,
  failedOne: (name: string): string =>
    `Couldn't finish restoring ${name}. Nothing of it was kept. Your other IDs are fine.`,
  tryAgain: 'Try again',
  hood: 'Under the hood',
  hoodLine: (agentId: string): string => `ID ${agentId}`,
  hoodKit: (kitId: string, contents: string): string => `Kit ${kitId} · ${contents}`,
} as const;

export const PROTECT = {
  title: (n: number): string => `You're back. ${n} ${n === 1 ? 'ID' : 'IDs'} restored.`,
  /** After the names (each in its own <bdi>). */
  leadRest: (n: number): string =>
    ` ${n === 1 ? 'is' : 'are'} on this computer with their people and messages. Two short things left.`,
  codeTitle: 'Your new master code for this computer',
  shownOnce: 'Shown once',
  codeBody: (sensor: string): string =>
    `${sensor} is on for this computer. This code is your backup for when ${sensor} can't be used. It replaces the master code of your old computer. Never give it to your AI.`,
  codeBodyNoSensor:
    'Your master code is how you confirm on this computer. Never give it to your AI.',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: "Couldn't copy. Select the code and copy it yourself.",
  print: 'Print',
  saved: 'I saved it',
  unchanged: (sensor: string): string => `${sensor} and your master code are unchanged.`,
  reconnect: 'Reconnect your AI apps',
  appFound: 'Found on this computer',
  appUses: (id: string): string => `Found on this computer · will use your ID ${id}`,
  connect: (id: string): string => `Connect to ${id}`,
  connected: 'Connected',
  noApps: 'No AI app found on this computer. You can connect one later in Settings.',
  looking: 'Looking for AI apps…',
  oldTitle: 'Still have the old computer?',
  old: 'Remove AgentLink there. Two computers using the same ID will both answer your people.',
  how: 'How',
  storage: 'Your storage needs reconnecting',
  tip: (date: string): string =>
    `Tip: this kit is from ${date}. Save a fresh one from Settings when you are settled.`,
  home: 'Go to Home',
  needSaved: 'Tick "I saved it" to continue.',
  partial: (names: string): string =>
    `Couldn't finish restoring ${names}. Nothing of it was kept. Your other IDs are fine.`,
  printTitle: 'AgentLink master code',
  printLead: (date: string): string => `For the computer restored on ${date}.`,
  printKeep: 'Keep this sheet private. Never give the code to your AI.',
} as const;

export const HOW = {
  title: 'Moving to a new computer',
  lead: 'Your IDs, people and messages come with you in a recovery kit.',
  steps: [
    'On this computer, open Settings, then Backup & restore, and save a new recovery kit.',
    'Copy the kit file to the new computer (a USB stick or your cloud drive is fine) and keep the recovery code on paper.',
    'On the new computer, install AgentLink, choose I have a recovery kit, pick the file and type the code.',
    'When it works there, remove AgentLink from this computer. Two computers using the same ID will both answer your people.',
  ] as const,
  start: 'Restore from a kit',
  back: 'Back',
} as const;

export const NEEDS_TERMINAL = {
  title: "This computer can't finish restoring here",
  body: 'The app needs Touch ID, Windows Hello or a passkey to protect this computer, and this browser has none to offer. You can restore from the terminal of this computer instead. Your AI is not part of this.',
  hoodTitle: 'Under the hood',
  hoodBody: 'In your own terminal, run:',
  command: 'agentlink restore',
  back: 'Back',
} as const;

export const PROBLEMS: Readonly<Record<RestoreProblem, string>> = {
  not_a_kit: KIT.notAKit,
  newer_version: KIT.newer,
  other_owner: KIT.otherOwner,
  wrong_code: CODE.wrong,
  damaged: CODE.damaged,
  wait: 'Too many tries. Wait a moment, then try again.',
  busy: 'Still working on the last step…',
  presence_required: "Confirm it's you first.",
  presence_rejected: PRESENCE.rejected,
  needs_terminal: NEEDS_TERMINAL.title,
  expired: 'This step timed out. Nothing was changed. Choose your kit file again.',
  too_large: "That file is too large to be a recovery kit. It wasn't opened.",
  invalid: "Something didn't match. Nothing was changed. Start again from the kit file.",
  failed: "Couldn't finish. Nothing was changed. Try again.",
  offline: "Can't reach AgentLink on this computer. Try again in a minute.",
  session: 'This page has timed out. Open AgentLink again.',
};

export const SENSOR_FALLBACK = 'your passkey';
