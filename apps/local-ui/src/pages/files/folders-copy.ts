// Files copy shared by Home's Files panel and Settings › Files (D-152; 11 §5.7; FILES-HOME-PANEL,
// FILES-SETTINGS-COPY; proposed, owner confirms at merge). Plain words (11 §5): no "wallet", "gas",
// "seed phrase" or "transaction", no "harness". Every string is fixed: nothing from another party,
// and nothing about what an AI app can do beyond the fixed tips (the app cannot see that).

/** `{computer}` (11 §5.7): "Mac" on macOS, "PC" on Windows, "computer" elsewhere. */
export function computerWord(platform: string = readPlatform()): string {
  if (/^Mac/i.test(platform)) return 'Mac';
  if (/^Win/i.test(platform)) return 'PC';
  return 'computer';
}

/** "Show in Finder" on macOS, "Show in Explorer" on Windows, "Show in folder" elsewhere (11 §5.7). */
export function showInLabel(platform: string = readPlatform()): string {
  if (/^Mac/i.test(platform)) return 'Show in Finder';
  if (/^Win/i.test(platform)) return 'Show in Explorer';
  return 'Show in folder';
}

function readPlatform(): string {
  try {
    return navigator.platform;
  } catch {
    return '';
  }
}

export const FILES_COPY = {
  /** The top line of Settings › Files (replaces "You don't upload here …"). */
  explainer:
    'Your AI sends files from your Send folder, and files you receive are saved in Inbox. To send a text file yourself, use Attach in a conversation.',
  /** The one line (Settings › Files, Send folders tab). */
  oneLine:
    'You put a file in Send, then ask your AI: “Send report.md to Ana.” Files people send you land in Inbox.',
  /** The Home panel's shorter line. */
  oneLineShort: 'Put a file in Send, then ask your AI to send it.',
  panelTitle: 'Files',
  /** FILES-ALLOWED-STATE: with several IDs, the panel says whose folders it shows. */
  forId: (id: string): string => `For ${id}`,
  panelEmpty: 'No files yet. Put a file in Send and ask your AI: “Send notes.md to Ana.”',
  noFolder: 'Allow your Send folder so your AI can send files.',
  allowSendFolder: 'Allow Send folder',
  working: 'Setting up…',
  allowFailed:
    "AgentLink couldn't set up your Send folder. You can allow a folder in Settings, then Files.",
  sendLabel: 'Send',
  sendLine: 'Your AI can send files from here, and only from here.',
  inboxLabel: 'Inbox',
  inboxLine: 'Files people send you are saved here. AgentLink never opens them.',
  chipAllowed: 'Allowed',
  chipNotAllowed: 'Not allowed',
  chipNotFound: (computer: string): string => `Not found on this ${computer}`,
  notAllowedLine: "AgentLink couldn't allow your Send folder, so your AI can't send files yet.",
  inboxNew: (n: number): string => `${String(n)} new`,
  manageFolders: 'Manage folders',
  tipsFor: (app: string): string => `Tips for ${app}`,
  tipsForUnknown: 'Tips for your AI app',
  aiAppHeading: 'Your AI app',
  collapse: 'Hide files',
  expand: 'Show files',
  unavailable: "Your files can't be shown right now.",
} as const;

/** The fixed tip of an AI app (11 §5.7): never a status, never a claim about what the app can do. */
export function appTip(app: string | undefined, computer: string): string {
  const name = app ?? '';
  if (name === 'Claude' || name === 'Claude Desktop') {
    return `In Claude, files Claude makes in a chat stay in Claude. To send one, ask Claude to send it as a text file (.md, .txt or .json), or save it into your Send folder yourself. If you gave Claude access to folders on this ${computer}, add your Send folder there too.`;
  }
  if (name === 'Claude Code' || name === 'Codex' || name === 'Cursor' || name === 'Windsurf') {
    return `${name} can work with files on this ${computer}. Ask it to save the file into your Send folder, then send it.`;
  }
  return `If your AI can't put files on this ${computer}, ask it to send the file as a text file (.md, .txt or .json), or save the file into your Send folder yourself.`;
}

/** Whether an app name has its own tip; any other name takes the unknown-app tip and label. */
export function isKnownApp(app: string | undefined): app is string {
  return (
    app === 'Claude' ||
    app === 'Claude Desktop' ||
    app === 'Claude Code' ||
    app === 'Codex' ||
    app === 'Cursor' ||
    app === 'Windsurf'
  );
}

/**
 * FILES-FOLDER-PICKER (D-154; 11 §5.7; proposed, owner confirms at merge): the folder row's actions,
 * its states and the browser's path field. Fixed text; a path is the owner's own folder, shown as
 * text only.
 */
export const PICKER_COPY = {
  change: 'Change…',
  addFolder: 'Add folder…',
  changeInboxLabel: '(where received files are saved)',
  addSendLabel: '(a folder your AI can send from)',
  checking: 'Checking…',
  pending: 'Not saved yet',
  inboxConfirmTitle: 'Save received files in this folder?',
  inboxConfirmBody:
    'Files people send you from now on are saved here. Files already saved stay where they are. AgentLink never opens received files.',
  inboxConfirm: 'Use this folder',
  inboxChanged: 'Done. New files people send you are saved in this folder.',
  pathField: 'Folder path',
  sendExample: 'For example ~/Documents/Shared',
  inboxExample: 'For example ~/Documents/Received',
  pasteHelp: (computer: string): string =>
    computer === 'Mac'
      ? 'Paste a folder path. In Finder, select the folder and press Option-Command-C to copy its path.'
      : computer === 'PC'
        ? 'Paste a folder path. In Explorer, select the folder and choose Copy as path.'
        : 'Paste the full path of a folder.',
  appTip: (computer: string): string =>
    computer === 'Mac'
      ? 'Tip: in the AgentLink app you can pick the folder in Finder.'
      : 'Tip: in the AgentLink app you can pick the folder in Explorer.',
  use: 'Use folder',
  cancel: 'Cancel',
  cantUse: (why: string): string => `That folder can't be used: ${why}`,
} as const;

const INBOX_WHY: Readonly<Record<string, string>> = {
  link: 'it’s a shortcut to another place. Choose the folder itself.',
  not_owned: 'it belongs to another user on this computer.',
  shared_writable: 'other users on this computer can change what’s in it.',
  os_folder: 'it’s a system or app folder.',
  send_folder:
    'it’s a folder your AI can send from, or inside or around one. Received files are kept apart.',
  not_writable: 'AgentLink can’t save files in it.',
  already_inbox: 'it’s already where received files are saved.',
  too_broad: 'it’s your whole computer or your whole home folder. Choose a folder inside it.',
  protected: 'it holds keys or AgentLink’s own data.',
  contains_protected: 'it holds keys or AgentLink’s own data.',
  hidden: 'it’s a hidden folder, or inside one.',
  missing: 'it doesn’t exist. Check the path.',
  not_folder: 'it isn’t a folder.',
  not_full_path: 'use the full path, for example ~/Documents/Received.',
  dot_segments: 'use the path without . or .. in it.',
  not_showable: 'its name has characters AgentLink can’t show safely.',
};

/** Why a folder can't hold received files (api/files-inbox.ts InboxRefusal), in plain words. */
export function inboxRefusalText(reason: string): string {
  return PICKER_COPY.cantUse(INBOX_WHY[reason] ?? 'choose another folder.');
}

/** The last part of a folder path, for the row's name (`~` stays `~`). */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length === 0 ? path : (parts[parts.length - 1] ?? path);
}

/** A long path cut in the middle (the start and the folder's own name stay); the row's title has it all. */
export function middleTruncate(path: string, max = 52): string {
  const chars = [...path];
  if (chars.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
