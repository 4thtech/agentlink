// The desktop app (apps/desktop) loads this UI with its own user-agent marker. Pages use it only to
// choose words: the desktop app is never "this browser". It grants nothing and gates nothing.
export const DESKTOP_UA_MARKER = 'AgentLinkDesktop/1';

export function inDesktopApp(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return ua.includes(DESKTOP_UA_MARKER);
}

/**
 * TRAY-WIDGET-UI (D-155): the menu bar widget's bridge. Only the popover's own preload (desktop app,
 * widget-preload.js) defines it; everywhere else it is absent. Each call needs a fresh user
 * activation and answers only true or false; it can open a page in the main window, close the
 * popover or quit, nothing more.
 */
export type WidgetRoute = 'home' | 'inbox' | 'approvals' | 'updates';
export interface AgentlinkWidgetBridge {
  open(request: { route: WidgetRoute; target?: string }): Promise<boolean>;
  quit(): Promise<boolean>;
  close(): Promise<boolean>;
}
declare global {
  interface Window {
    agentlinkWidget?: AgentlinkWidgetBridge;
  }
}
