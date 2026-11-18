// The widget's way to the main window (D-155). In the desktop app the popover's preload offers
// `window.agentlinkWidget`; each call needs a fresh user activation and answers only true or false.
// Without it (the page opened in a browser tab) a click hands over like the compact view does.
import type { WidgetRoute } from '../../desktop.js';
import { openInMainApp } from '../compact/open.js';

/** Served as an app page by the existing server (`/settings/<name>`); the popover loads it. */
export const WIDGET_PAGE_PATH = '/settings/widget';

const PATHS: Readonly<Record<WidgetRoute, string>> = {
  home: '/',
  inbox: '/',
  files: '/',
  approvals: '/',
  updates: '/settings/updates',
};

/** Opens a page of the main window. Never decides anything there. */
export async function openMain(route: WidgetRoute, target?: string): Promise<boolean> {
  const bridge = typeof window === 'undefined' ? undefined : window.agentlinkWidget;
  if (bridge === undefined) {
    try {
      openInMainApp(PATHS[route]);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return await bridge.open(target === undefined ? { route } : { route, target });
  } catch {
    return false;
  }
}

export async function quitApp(): Promise<boolean> {
  try {
    return (await window.agentlinkWidget?.quit()) === true;
  } catch {
    return false;
  }
}

export async function closeWidget(): Promise<boolean> {
  try {
    return (await window.agentlinkWidget?.close()) === true;
  } catch {
    return false;
  }
}
