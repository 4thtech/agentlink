// DESK-D12c (D-145 phase 2; 11 §5): is this page inside the AgentLink desktop app, and on which
// platform? The app's window adds the marker `AgentLinkDesktop/1` to its user agent (the shell sets
// it); a browser never has it. This only decides what the page OFFERS: the server checks presence
// either way (a page that lies about it gains nothing, the native kind needs the app's helper).
export const DESKTOP_MARKER = 'AgentLinkDesktop/1';

export type DesktopPlatform = 'mac' | 'windows';

const MARKER = /(?:^|\s)AgentLinkDesktop\/1(?:\s|$)/;

/** 'mac' or 'windows' inside the desktop app; undefined in a browser and on other platforms. */
export function desktopPlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): DesktopPlatform | undefined {
  if (!MARKER.test(userAgent)) return undefined;
  if (/\bMacintosh\b|\bMac OS X\b/.test(userAgent)) return 'mac';
  if (/\bWindows NT\b/.test(userAgent)) return 'windows';
  return undefined;
}

/** The primary confirm on presence screens (11 §5: the platform's own word). */
export function nativeConfirmLabel(platform: DesktopPlatform): string {
  return platform === 'mac' ? 'Use Touch ID' : 'Use Windows Hello';
}

/** The first-time setup offer. */
export function nativeSetupLabel(platform: DesktopPlatform): string {
  return platform === 'mac'
    ? 'Turn on Touch ID for approvals'
    : 'Turn on Windows Hello for approvals';
}

/** The platform's sensor word, for messages. */
export function nativeSensor(platform: DesktopPlatform): string {
  return platform === 'mac' ? 'Touch ID' : 'Windows Hello';
}
