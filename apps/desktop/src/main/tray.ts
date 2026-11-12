// The minimal tray / menu-bar icon (WP-D2). Two items: open the window, quit. The tooltip shows a
// fixed word for the core's state and numbers only (never a name or message text). WP-D8 replaces
// this with the shape-coded icons, the popover and notifications.
import type { HostState } from '../shared/protocol.js';
import type { ElectronModule, Tray } from './electron-api.js';

export const TRAY_COPY = {
  open: 'Open AgentLink',
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
  readonly quit: () => void;
}

export class AppTray {
  readonly #tray: Tray;

  constructor(
    electron: Pick<ElectronModule, 'Tray' | 'Menu'>,
    iconPath: string,
    actions: TrayActions,
  ) {
    this.#tray = new electron.Tray(iconPath);
    this.#tray.setToolTip(trayTooltip('starting', 0));
    this.#tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: TRAY_COPY.open, click: actions.open },
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
