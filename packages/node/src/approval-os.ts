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
// The session link holds the view-only session token, so it appears in the opener's argv for a
// moment. A same-user process can read that; it is the same G-1 residual as 04 §2.5 (the token only
// grants viewing; every decision still needs owner presence).
import { execFile, type ExecFileOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import process from 'node:process';

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
}

const nodeSeams = (): OsSeams => ({
  platform: process.platform,
  env: process.env,
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

function windowsExplorer(env: OsSeams['env']): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'];
  return typeof root === 'string' && WINDOWS_ROOT.test(root)
    ? `${root}\\explorer.exe`
    : OS_PROGRAMS.winExplorer;
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

/** The URL opener over `seams` (internal; the package uses osBrowserOpener). */
export function browserOpenerWith(seams: OsSeams): BrowserOpener {
  return (url) => {
    switch (seams.platform) {
      case 'darwin':
        return run(seams, OS_PROGRAMS.darwinOpen, [url]);
      case 'win32':
        return run(seams, windowsExplorer(seams.env), [url], true);
      default:
        return run(seams, OS_PROGRAMS.linuxOpen, [url]);
    }
  };
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

/** The platform's URL opener: `/usr/bin/open`, `/usr/bin/xdg-open` or `explorer.exe`. */
export const osBrowserOpener: BrowserOpener = (url) => browserOpenerWith(nodeSeams())(url);

/** The platform's notification. */
export const osNotifier: OsNotifier = (lines) => notifierWith(nodeSeams())(lines);
