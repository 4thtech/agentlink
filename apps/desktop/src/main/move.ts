// Refuse to run from a translocated, read-only or temporary location (plan Decision 2
// "Translocation", Fable M3), and offer "Move to Applications" on macOS.
//
// Why: AI apps start the MCP from an absolute path inside the installed app (WP-D7). A path inside
// macOS App Translocation (a random read-only copy), a mounted disk image (/Volumes/…, read-only),
// or a temporary folder (a zip opened in place on Windows) disappears or changes, and a read-only
// copy cannot be updated. So the shell does not start the core there.
//
// macOS: when the app is not in an Applications folder and its bundle is translocated, on a
// read-only volume or in a temporary folder, a dialog offers "Move to Applications" (Electron's
// app.moveToApplicationsFolder, which resolves the translocated original, moves it and relaunches)
// or "Quit". Windows: the same refusal with "Quit" only (the installer puts the app in
// %LOCALAPPDATA%\Programs\AgentLink). Pure decision + an injected dialog step.
import type { App, Dialog } from './electron-api.js';

export type LocationProblem = 'translocated' | 'read_only' | 'temporary';

export interface LocationInput {
  readonly platform: string;
  /** process.execPath (the app's executable). */
  readonly execPath: string;
  /** os.tmpdir(), resolved. */
  readonly tmpDir: string;
  /** True when the directory can be written by this user (fs.accessSync W_OK). */
  readonly writable: (path: string) => boolean;
}

const norm = (path: string, platform: string): string => {
  const slashes = platform === 'win32' ? path.replaceAll('\\', '/') : path;
  return platform === 'win32' ? slashes.toLowerCase() : slashes;
};

/** The .app bundle path on macOS (…/AgentLink.app), or the exe's folder elsewhere. */
export function appRoot(execPath: string, platform: string): string {
  if (platform === 'darwin') {
    const at = execPath.indexOf('.app/Contents/MacOS/');
    if (at >= 0) return execPath.slice(0, at + '.app'.length);
  }
  const sep =
    platform === 'win32'
      ? Math.max(execPath.lastIndexOf('\\'), execPath.lastIndexOf('/'))
      : execPath.lastIndexOf('/');
  return sep > 0 ? execPath.slice(0, sep) : execPath;
}

/** /Applications/X.app or ~/Applications/X.app (directly inside the folder). */
function inApplications(bundle: string): boolean {
  return /^(?:\/Users\/[^/]+)?\/Applications\/[^/]+\.app$/.test(bundle);
}

/** What is wrong with where the app runs from, or null when the location is fine. */
export function locationProblem(input: LocationInput): LocationProblem | null {
  const root = appRoot(input.execPath, input.platform);
  const path = norm(root, input.platform);
  if (input.platform === 'darwin') {
    if (path.includes('/AppTranslocation/')) return 'translocated';
    if (path.startsWith('/Volumes/') && !input.writable(root)) return 'read_only';
  }
  const tmp = norm(input.tmpDir, input.platform).replace(/\/+$/, '');
  if (tmp.length > 1 && (path === tmp || path.startsWith(`${tmp}/`))) return 'temporary';
  const privateTmp =
    input.platform === 'darwin' && !tmp.startsWith('/private/') ? `/private${tmp}` : null;
  if (privateTmp !== null && path.startsWith(`${privateTmp}/`)) return 'temporary';
  // An app already in an Applications folder is where it belongs: a standard (non-admin) user often
  // cannot write there, and that is fine (the app writes only to ~/.agentlink).
  if (input.platform === 'darwin' && inApplications(path)) return null;
  if (!input.writable(root)) return 'read_only';
  return null;
}

/** Fixed copy (11 §5 vocabulary). */
export const MOVE_COPY = {
  title: 'AgentLink',
  macMessage: 'Move AgentLink to your Applications folder',
  macDetail:
    'AgentLink can’t run from this place. Move it to Applications, and it opens again from there.',
  move: 'Move to Applications',
  quit: 'Quit',
  winMessage: 'Install AgentLink first',
  winDetail:
    'AgentLink can’t run from this place. Run the AgentLink installer, then open AgentLink from the Start menu.',
  failedMessage: 'AgentLink couldn’t move itself',
  failedDetail: 'Drag AgentLink to your Applications folder in Finder, then open it from there.',
} as const;

export type LocationOutcome = 'ok' | 'moved' | 'quit';

/**
 * Checks the location; when it is a problem, asks the person and acts. "moved" means Electron is
 * relaunching from Applications: the caller must not start anything. "quit": exit without a core.
 */
export async function ensureGoodLocation(
  input: LocationInput,
  app: Pick<App, 'moveToApplicationsFolder'>,
  dialog: Dialog,
): Promise<LocationOutcome> {
  if (locationProblem(input) === null) return 'ok';
  if (input.platform === 'darwin' && typeof app.moveToApplicationsFolder === 'function') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: MOVE_COPY.title,
      message: MOVE_COPY.macMessage,
      detail: MOVE_COPY.macDetail,
      buttons: [MOVE_COPY.move, MOVE_COPY.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return 'quit';
    let moved: boolean;
    try {
      // An existing AgentLink in Applications is replaced only when it is not running.
      moved = app.moveToApplicationsFolder({ conflictHandler: (kind) => kind === 'exists' });
    } catch {
      moved = false;
    }
    if (moved) return 'moved';
    await dialog.showMessageBox({
      type: 'error',
      title: MOVE_COPY.title,
      message: MOVE_COPY.failedMessage,
      detail: MOVE_COPY.failedDetail,
      buttons: [MOVE_COPY.quit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return 'quit';
  }
  await dialog.showMessageBox({
    type: 'warning',
    title: MOVE_COPY.title,
    message: MOVE_COPY.winMessage,
    detail: MOVE_COPY.winDetail,
    buttons: [MOVE_COPY.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return 'quit';
}
