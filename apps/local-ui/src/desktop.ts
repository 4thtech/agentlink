// The desktop app (apps/desktop) loads this UI with its own user-agent marker. Pages use it only to
// choose words: the desktop app is never "this browser". It grants nothing and gates nothing.
export const DESKTOP_UA_MARKER = 'AgentLinkDesktop/1';

export function inDesktopApp(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return ua.includes(DESKTOP_UA_MARKER);
}
