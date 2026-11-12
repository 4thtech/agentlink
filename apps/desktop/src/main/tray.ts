// The minimal tray / menu-bar icon (WP-D2). Three items: open the window, try again (after the core could not start), quit. The tooltip shows a
// fixed word for the core's state and numbers only (never a name or message text). WP-D8 replaces
// this with the shape-coded icons, the popover and notifications.
import type { HostState } from '../shared/protocol.js';
import type { ElectronModule, NativeImage, NativeImageModule, Tray } from './electron-api.js';

/**
 * The built-in tray image (a ring with a dot; 36×36 px black on transparent, shown at 18 pt with
 * scale factor 2). Used when the packaged icon file is missing or unreadable, so the menu-bar /
 * tray item ALWAYS exists (the only way back to the window after it is closed).
 */
export const BUILTIN_TRAY_PNG: Uint8Array = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAA+UlEQVR42u1YwQ3DIAy8ERjBIzBKRmKDjMAoGYFRGIH2waOKMMFJUK9qLDmPBKPD3GET4LE/sQXACmADUHa+1W/LbBDu/QgAcgOE5rnGuBkZsQBpAbstY/ECkL3H2WBSHROqx/puCqh4wAvpxMoB3+IZzhRFQWKYRxQlFgunnLKyePPW51H1BSUzV62VqTASmBsrkRsAiTK3mTtHq/AfKvMnst/l0toIkA7XtNLhOlnaj18t+5yMnBjhXLLwc1RZfuBU9gbFDQMKBi5cif1dQF/fMjpS08me7mCkKx2UxZWu/aBr0ChbWMomn/IaRHlRpLxKU/5seIzCXiDEpiwp4JgJAAAAAElFTkSuQmCC',
    'base64',
  ),
);

/**
 * The tray image: the icon file when it loads, else the built-in one. On macOS it is a template
 * image (the menu bar tints it for light and dark).
 */
export function trayImage(
  nativeImage: NativeImageModule,
  iconPath: string,
  platform: string,
): NativeImage {
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createFromBuffer(BUILTIN_TRAY_PNG, { scaleFactor: 2 });
  if (platform === 'darwin') image.setTemplateImage(true);
  return image;
}

export const TRAY_COPY = {
  open: 'Open AgentLink',
  retry: 'Try again',
  quit: 'Quit AgentLink',
  base: 'AgentLink',
} as const;

const STATE_WORDS: Record<HostState | 'failed', string> = {
  starting: 'Starting',
  running: 'Running',
  closing: 'Closing',
  failed: 'Not running',
};

/** The tooltip: "AgentLink: <state>", plus "· <n> waiting" when approvals wait. Numbers only. */
export function trayTooltip(state: HostState | 'failed', approvals: number): string {
  const waiting = Number.isSafeInteger(approvals) && approvals > 0 ? ` · ${approvals} waiting` : '';
  return `${TRAY_COPY.base}: ${STATE_WORDS[state]}${waiting}`;
}

export interface TrayActions {
  readonly open: () => void;
  /** Starts the core again after it could not start (only does something when it failed). */
  readonly retry: () => void;
  readonly quit: () => void;
}

export class AppTray {
  readonly #tray: Tray;

  constructor(
    electron: Pick<ElectronModule, 'Tray' | 'Menu'>,
    icon: string | NativeImage,
    actions: TrayActions,
  ) {
    this.#tray = new electron.Tray(icon);
    this.#tray.setToolTip(trayTooltip('starting', 0));
    this.#tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: TRAY_COPY.open, click: actions.open },
        { label: TRAY_COPY.retry, click: actions.retry },
        { type: 'separator' },
        { label: TRAY_COPY.quit, click: actions.quit },
      ]),
    );
    this.#tray.on('click', actions.open);
  }

  update(state: HostState | 'failed', approvals: number): void {
    this.#tray.setToolTip(trayTooltip(state, approvals));
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
