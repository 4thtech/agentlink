// F40 (Windows 11, 0.4.10 via the installer): the CLI said "Your browser opened…" when no browser
// opened. An OS opener cannot prove a page loaded (Windows explorer.exe exits 1 either way), so:
//
// - the first line says "Opening AgentLink in your browser…", never that it opened;
// - the server knows when a one-shot session link is used (ApprovalServer `activity.linksUsed`, a
//   count). When none was used within OPEN_CHECK_MS, one follow-up asks the person to press Enter
//   in this terminal, which runs the same opener again with a freshly minted one-shot link.
//
// The link and its token go only to the OS opener (04 §2.5, D-130 (3)): nothing here sees, prints or
// logs them. Enter is read only from the owner's own terminal (the caller checked it); an AI that
// can type in that terminal could already re-run the command, so the retry adds no capability.
import process from 'node:process';

/** How long a page has to load its one-shot link before the follow-up (F40). */
export const OPEN_CHECK_MS = 15_000;

/** Fixed text (11 §5 plain words). Nothing from a link, file or the page is inserted. */
export const OPEN_TEXT = Object.freeze({
  notOpened: "Your browser didn't open AgentLink. Press Enter here to try again.",
  retryHint: 'Press Enter here to try again.',
  retrying: 'Opening AgentLink in your browser…',
  retryFailed: "AgentLink couldn't open your browser. Press Enter here to try again.",
});

/** F41: the platform's own word for the owner gesture (the first-run page uses the same words). */
export function presenceWord(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Touch ID';
  if (platform === 'win32') return 'Windows Hello';
  return 'a passkey';
}

/** F41: the opened line while no owner exists (first run), with no "setup page". */
export function setupOpenedLine(platform: NodeJS.Platform): string {
  return `Opening AgentLink in your browser… Set it up there and protect your approvals with ${presenceWord(platform)}. Keep this window open while you use it; press Ctrl+C when you're done.`;
}

export interface OpenWatchDeps {
  /** Runs the OS opener with a new one-shot link; false when nothing could be started. */
  readonly open: () => Promise<boolean>;
  /** How many one-shot links the server has seen used. Absent: no follow-up. */
  readonly linksUsed?: (() => number) | undefined;
  readonly print: (line: string) => void;
  /** Calls `press` on Enter in the owner's terminal; returns the unsubscribe. Absent: no retry. */
  readonly onEnter?: ((press: () => void) => () => void) | undefined;
  readonly checkMs: number;
}

export interface OpenWatch {
  /** Whether the first opener run started. */
  readonly opened: boolean;
  /** Ends the watch: no later line, Enter no longer read. */
  stop(): void;
}

/**
 * Opens once and prints `lines.opened` (or `lines.failed`); then, while no one-shot link is used,
 * offers Enter to try again. Without `lines.failed` a failed opener prints nothing and is not
 * retried (the caller has its own way on).
 */
export async function openAndWatch(
  deps: OpenWatchDeps,
  lines: { readonly opened: string; readonly failed?: string },
): Promise<OpenWatch> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const { linksUsed, onEnter } = deps;
  const used = (): number => {
    try {
      return linksUsed?.() ?? 0;
    } catch {
      return 0;
    }
  };
  const tryOpen = (): Promise<boolean> => deps.open().catch(() => false);

  const disarm = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const arm = (): void => {
    if (stopped || onEnter === undefined || unsubscribe !== undefined) return;
    unsubscribe = onEnter(() => {
      if (stopped || unsubscribe === undefined) return;
      disarm();
      void retry();
    });
  };
  const watch = (base: number): void => {
    if (stopped || linksUsed === undefined || onEnter === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || used() !== base) return;
      deps.print(OPEN_TEXT.notOpened);
      arm();
    }, deps.checkMs);
  };
  const retry = async (): Promise<void> => {
    const base = used();
    const ok = await tryOpen();
    if (stopped) return;
    if (!ok) {
      deps.print(OPEN_TEXT.retryFailed);
      arm();
      return;
    }
    deps.print(OPEN_TEXT.retrying);
    watch(base);
  };

  const base = used();
  const opened = await tryOpen();
  if (opened) {
    deps.print(lines.opened);
    watch(base);
  } else if (lines.failed !== undefined) {
    deps.print(lines.failed);
    if (onEnter !== undefined) {
      deps.print(OPEN_TEXT.retryHint);
      arm();
    }
  }
  return Object.freeze<OpenWatch>({
    opened,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      disarm();
    },
  });
}

/**
 * The production Enter: a line on standard input while it is a terminal. Reading starts only when
 * the follow-up is shown and stops (paused, listener removed) on unsubscribe, so the process can end.
 */
export function stdinEnter(
  stdin: NodeJS.ReadStream = process.stdin,
): ((press: () => void) => () => void) | undefined {
  if (stdin.isTTY !== true) return undefined;
  return (press) => {
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes('\n') || text.includes('\r')) press();
    };
    stdin.on('data', onData);
    stdin.resume();
    return () => {
      stdin.off('data', onData);
      stdin.pause();
    };
  };
}
