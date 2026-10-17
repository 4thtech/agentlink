// M1-8d: the two OS touches of the local approval server (08 §1): opening the owner's browser at the
// session link, and a fixed OS notification when a new approval request is waiting.
//
// Both run a fixed program with fixed arguments through execFile (no shell). The notification text
// is a constant: no request summary, contact name or other stored or inbound text reaches the OS
// (I-5). Both are best effort and report only whether the program ran.
//
// The session link holds the view-only session token, so it appears in the opener's argv for a
// moment. A same-user process can read that; it is the same G-1 residual as 04 §2.5 (the token only
// grants viewing; every decision still needs owner presence).
import { execFile } from 'node:child_process';
import process from 'node:process';

/** Opens `url` in the owner's default browser. Resolves false when nothing could be started. */
export type BrowserOpener = (url: string) => Promise<boolean>;
/** Shows a title and a body line as an OS notification. Resolves false when it could not. */
export type OsNotifier = (lines: readonly [title: string, body: string]) => Promise<boolean>;

const RUN_TIMEOUT_MS = 10_000;

function run(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        [...args],
        { timeout: RUN_TIMEOUT_MS, windowsHide: true, shell: false },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

/** The platform's URL opener: `open` (macOS), `xdg-open` (Linux, BSD), `explorer.exe` (Windows). */
export const osBrowserOpener: BrowserOpener = (url) => {
  switch (process.platform) {
    case 'darwin':
      return run('open', [url]);
    case 'win32':
      return run('explorer.exe', [url]);
    default:
      return run('xdg-open', [url]);
  }
};

/** AppleScript string literal for a fixed text (only `\` and `"` need escaping). */
const appleString = (text: string): string => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * The platform's notification: `osascript` (macOS) or `notify-send` (Linux). On Windows there is no
 * dependency-free notification command; it resolves false and the agent's `pending_approval` link
 * remains the way in (06 §2.5).
 */
export const osNotifier: OsNotifier = ([title, body]) => {
  switch (process.platform) {
    case 'darwin':
      return run('osascript', [
        '-e',
        `display notification ${appleString(body)} with title ${appleString(title)}`,
      ]);
    case 'win32':
      return Promise.resolve(false);
    default:
      return run('notify-send', ['--app-name=AgentLink', title, body]);
  }
};
