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
