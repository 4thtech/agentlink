// M1-8d: the OS touches of the local approval server (08 §1): opening the owner's browser at the
// session link, and a fixed OS notification when a new approval request is waiting. MSG-FILES-IO-h
// adds a third: showing one checked, saved received file in the OS file manager (Show in Finder).
//
// Both run a fixed program, by absolute path, with fixed arguments through execFile (no shell). The
// notification text is a constant: no request summary, contact name or other stored or inbound text
// reaches the OS (I-5). Both are best effort and report only whether the program ran.
//
// M1-11a-b (IR-M1-11a-b-1 L-2): the programs are never resolved through PATH, which under `npx`
// holds user-writable directories where a same-user process could plant an `open` that captures the
// session link. A program that is not at its path is not run: the opener resolves false and
// `agentlink mcp` falls back to the `agentlink approve` command.
//
// R1-SEC-05 (04 §2.8 "other OS users"; 08 §1 the link token is in memory only): the session link
// never reaches the opener's argv, which other OS users can read (`ps`, /proc/<pid>/cmdline). The
// opener writes a private launch page (writePrivateLaunchFile: mode 0600, a random name, in the
// owner's own 0700 folder `~/.agentlink/open`) that sends the browser on to the link, and hands the
// OS opener only that file's path. A link that is not exactly this server's own session link
// (`http://localhost:<port>/<page>?t=<token>`) is never written or opened; a launch file that cannot
// be written opens nothing (never a fallback to argv). Launch files are removed after
// LAUNCH_FILE_LIFETIME_MS (and stale ones swept on the next write); the token in one is one-shot.
// A same-user process could still read the file: the G-1 residual of 04 §2.5 (viewing only; every
// decision needs owner presence). The desktop shell gets the link over its private pipe instead
// (startApprovalServerWithLinkSink), never through this opener.
import { execFile, type ExecFileOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';

/** Opens `url` in the owner's default browser. Resolves false when nothing could be started. */
export type BrowserOpener = (url: string) => Promise<boolean>;
/** Shows a title and a body line as an OS notification. Resolves false when it could not. */
export type OsNotifier = (lines: readonly [title: string, body: string]) => Promise<boolean>;

const RUN_TIMEOUT_MS = 10_000;

/** The programs run, by absolute path only (IR-M1-11a-b-1 L-2). */
export const OS_PROGRAMS = Object.freeze({
  darwinOpen: '/usr/bin/open',
  darwinNotify: '/usr/bin/osascript',
  linuxOpen: '/usr/bin/xdg-open',
  linuxNotify: '/usr/bin/notify-send',
  /** The default; `%SystemRoot%\explorer.exe` when SystemRoot is a plain `X:\Windows`. */
  winExplorer: 'C:\\Windows\\explorer.exe',
  /** F40: the default; `%SystemRoot%\System32\rundll32.exe` under the same SystemRoot rule. */
  winRundll32: 'C:\\Windows\\System32\\rundll32.exe',
});

/** The execFile options of every run: never a shell. */
export const RUN_OPTIONS: Readonly<ExecFileOptions> = Object.freeze({
  timeout: RUN_TIMEOUT_MS,
  windowsHide: true,
  shell: false,
});

type RunError = (Error & { code?: unknown; killed?: boolean }) | null;

/** Internal (tests): the OS seams of the opener and the notifier. */
export interface OsSeams {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True when `path` is an executable file. */
  readonly executable: (path: string) => boolean;
  readonly execFile: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: RunError) => void,
  ) => void;
  /** R1-SEC-05: writes the launch page as a private file; its absolute path, or undefined. */
  readonly writeLaunchFile: (html: string) => Promise<string | undefined>;
}

/** R1-SEC-05: how long a launch file is kept (the browser reads it at once; the link is one-shot). */
export const LAUNCH_FILE_LIFETIME_MS = 2 * 60_000;

/** The owner's launch folder: `~/.agentlink/open`. */
export function launchFolder(home: string = homedir()): string {
  return join(home, '.agentlink', 'open');
}

/**
 * R1-SEC-05: only this server's own session link is ever written: a fixed origin form, a page path
 * of plain segments and a base64url token. Nothing in it needs escaping in the launch page.
 */
const SESSION_LINK =
  /^http:\/\/localhost:[1-9][0-9]{0,4}\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\?t=[A-Za-z0-9_-]{16,128}$/;

/** R1-SEC-05: the launch page for `link`, or undefined when it is not a session link. */
export function launchPage(link: string): string | undefined {
  if (!SESSION_LINK.test(link)) return undefined;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">` +
    '<meta name="referrer" content="no-referrer">' +
    `<meta http-equiv="refresh" content="0;url=${link}">` +
    '<title>AgentLink</title></head>' +
    `<body><p><a href="${link}">Open AgentLink</a></p></body></html>`
  );
}

/**
 * R1-SEC-05: writes `html` as a new file with a random name in `dir`, mode 0600, created exclusively
 * and never through a link. `dir` is created 0700 when missing; one that is a link, not a folder or
 * (POSIX) not this user's is refused, and its mode is set to 0700. Files older than
 * LAUNCH_FILE_LIFETIME_MS are removed first. Resolves the path, or undefined on any failure.
 */
export async function writePrivateLaunchFile(
  dir: string,
  html: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const folder = await lstat(dir);
    if (folder.isSymbolicLink() || !folder.isDirectory()) return undefined;
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && folder.uid !== process.getuid()) return undefined;
      await chmod(dir, 0o700);
    }
    await sweepLaunchFolder(dir, now);
    const path = join(dir, `${encodeHex(randomBytes(16))}.html`);
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
    const handle = await open(path, flags, 0o600);
    try {
      await handle.writeFile(html, 'utf8');
    } finally {
      await handle.close();
    }
    return path;
  } catch {
    return undefined;
  }
}

/** Removes the launch folder's files older than LAUNCH_FILE_LIFETIME_MS (best effort). */
async function sweepLaunchFolder(dir: string, now: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(dir, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || info.isDirectory()) continue;
    if (now - info.mtimeMs > LAUNCH_FILE_LIFETIME_MS) await unlink(path).catch(() => undefined);
  }
}

/** Removes one launch file after LAUNCH_FILE_LIFETIME_MS, without keeping the process alive. */
function removeLater(path: string): void {
  const timer = setTimeout(() => void unlink(path).catch(() => undefined), LAUNCH_FILE_LIFETIME_MS);
  timer.unref?.();
}

const nodeSeams = (): OsSeams => ({
  platform: process.platform,
  env: process.env,
  writeLaunchFile: async (html) => {
    const path = await writePrivateLaunchFile(launchFolder(), html);
    if (path !== undefined) removeLater(path);
    return path;
  },
  executable: (path) => {
    try {
      accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  execFile: (file, args, options, callback) => {
    execFile(file, [...args], options, (error) => callback(error));
  },
});

const WINDOWS_ROOT = /^[A-Za-z]:\\Windows$/i;

function windowsRoot(env: OsSeams['env']): string | undefined {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  return typeof root === 'string' && WINDOWS_ROOT.test(root) ? root : undefined;
}

function windowsExplorer(env: OsSeams['env']): string {
  const root = windowsRoot(env);
  return root === undefined ? OS_PROGRAMS.winExplorer : `${root}\\explorer.exe`;
}

function windowsRundll32(env: OsSeams['env']): string {
  const root = windowsRoot(env);
  return root === undefined ? OS_PROGRAMS.winRundll32 : `${root}\\System32\\rundll32.exe`;
}

/**
 * Runs a fixed program by absolute path. `anyExit`: the program ran, whatever its exit code, counts
 * as success (Windows `explorer.exe` exits 1 even when it opened the URL).
 */
function run(
  seams: OsSeams,
  program: string,
  args: readonly string[],
  anyExit = false,
  verbatim = false,
): Promise<boolean> {
  if (!seams.executable(program)) return Promise.resolve(false);
  const options: ExecFileOptions = verbatim
    ? { ...RUN_OPTIONS, windowsVerbatimArguments: true }
    : { ...RUN_OPTIONS };
  return new Promise((resolve) => {
    try {
      seams.execFile(program, [...args], options, (error) =>
        resolve(
          error === null || (anyExit && typeof error.code === 'number' && error.killed !== true),
        ),
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * R1-SEC-05: the `file:///C:/...` URL of a launch file on a drive (each segment percent-encoded, so
 * no space or quote reaches the command line); undefined for any other path.
 */
function windowsLaunchUrl(file: string): string | undefined {
  if (!/^[A-Za-z]:\\[^\\]/.test(file)) return undefined;
  const [drive, ...rest] = file.split('\\');
  return `file:///${[drive, ...rest.map((part) => encodeURIComponent(part))].join('/')}`;
}

/** The URL opener over `seams` (internal; the package uses osBrowserOpener). */
export function browserOpenerWith(seams: OsSeams): BrowserOpener {
  return async (url) => {
    // R1-SEC-05: the OS opener gets the launch file's path, never the link.
    const page = launchPage(url);
    if (page === undefined) return false;
    const file = await seams.writeLaunchFile(page).catch(() => undefined);
    if (file === undefined) return false;
    switch (seams.platform) {
      case 'darwin':
        return run(seams, OS_PROGRAMS.darwinOpen, [file]);
      case 'win32': {
        // A file: URL (no spaces, no quoting) of the launch file, for the default .html handler.
        const launchUrl = windowsLaunchUrl(file);
        return launchUrl === undefined ? false : windowsOpen(seams, launchUrl);
      }
      default:
        return run(seams, OS_PROGRAMS.linuxOpen, [file]);
    }
  };
}

/**
 * F40 (Windows 11, 0.4.10): `explorer.exe <url>` exits 1 whether or not a browser opened, so a
 * silent failure read as success. `rundll32.exe url.dll,FileProtocolHandler <url>` hands the url to
 * the default browser and reports a failure to start; explorer.exe stays the fallback. Both by
 * absolute path under SystemRoot, shell false, the url as its own argument (Node quotes it for the
 * Windows command line; the url is ours: origin, fixed path, base64url token). Never cmd.exe or
 * `start`, whose command line would parse the url. Neither result proves a page loaded: the CLI
 * also watches whether the one-shot link was used (ApprovalServer `activity.linksUsed`).
 */
async function windowsOpen(seams: OsSeams, url: string): Promise<boolean> {
  if (await run(seams, windowsRundll32(seams.env), ['url.dll,FileProtocolHandler', url])) {
    return true;
  }
  return run(seams, windowsExplorer(seams.env), [url], true);
}

/** AppleScript string literal for a fixed text (only `\` and `"` need escaping). */
const appleString = (text: string): string => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * The notification over `seams`: `osascript` (macOS) or `notify-send` (Linux). On Windows there is
 * no dependency-free notification command; it resolves false and the agent's `pending_approval`
 * link remains the way in (06 §2.5).
 */
export function notifierWith(seams: OsSeams): OsNotifier {
  return ([title, body]) => {
    switch (seams.platform) {
      case 'darwin':
        return run(seams, OS_PROGRAMS.darwinNotify, [
          '-e',
          `display notification ${appleString(body)} with title ${appleString(title)}`,
        ]);
      case 'win32':
        return Promise.resolve(false);
      default:
        return run(seams, OS_PROGRAMS.linuxNotify, ['--app-name=AgentLink', title, body]);
    }
  };
}

/**
 * MSG-FILES-IO-h: shows one checked file in the OS file manager (Show in Finder, D-134). `file` is
 * the path local-ui/reveal-file.ts checked inside the Inbox folder, `folder` that folder's realpath;
 * neither ever comes from a request. Resolves false when nothing could be started.
 */
export type FileRevealer = (file: string, folder: string) => Promise<boolean>;

/**
 * A full path that cannot read as an option, with no NUL (the paths are checked before; defence in
 * depth). On Windows also no `"`: the path is quoted by us (fileRevealerWith), and a `"` cannot occur
 * in a Windows path anyway (sanitizeFileName removes it from the saved name).
 */
function revealablePath(p: string, platform: NodeJS.Platform): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false;
  return platform === 'win32' ? /^[A-Za-z]:\\/.test(p) && !p.includes('"') : p.startsWith('/');
}

/**
 * The revealer over `seams`: macOS `open -R <file>` (Finder selects it), Windows
 * `explorer.exe /select,"<file>"` (exits 1 even when it worked), elsewhere `xdg-open <folder>` (no
 * portable "select" exists, so the folder opens). Fixed programs by absolute path, shell false, the
 * path as its own argument. explorer.exe parses its own command line and splits on commas, so on
 * Windows the path is quoted here and passed verbatim (windowsVerbatimArguments, still no shell); it
 * holds no `"` (revealablePath), so the quotes cannot be closed early (CHORE-MAIN-NODEOS-040).
 */
export function fileRevealerWith(seams: OsSeams): FileRevealer {
  return (file, folder) => {
    if (!revealablePath(file, seams.platform) || !revealablePath(folder, seams.platform)) {
      return Promise.resolve(false);
    }
    switch (seams.platform) {
      case 'darwin':
        return run(seams, OS_PROGRAMS.darwinOpen, ['-R', file]);
      case 'win32':
        return run(seams, windowsExplorer(seams.env), [`/select,"${file}"`], true, true);
      default:
        return run(seams, OS_PROGRAMS.linuxOpen, [folder]);
    }
  };
}

/** The platform's file revealer. */
export const osFileRevealer: FileRevealer = (file, folder) =>
  fileRevealerWith(nodeSeams())(file, folder);

/** The platform's URL opener: `/usr/bin/open`, `/usr/bin/xdg-open`, or rundll32 then explorer.exe. */
export const osBrowserOpener: BrowserOpener = (url) => browserOpenerWith(nodeSeams())(url);

/** The platform's notification. */
export const osNotifier: OsNotifier = (lines) => notifierWith(nodeSeams())(lines);
