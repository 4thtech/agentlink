// UI-REFRESH-f: the browser's platform, read once at start-up and put on <html> as `data-os`
// (B-11 §13.2, §18 decision 3). Only a Mac desktop gets the translucent chrome (chrome.css);
// Windows and Linux keep it solid, and an unknown platform sets nothing, which is solid too.
export type OsName = 'macos' | 'windows' | 'linux' | 'other';

/** The few navigator fields read here; a test hands in a plain object. */
export interface PlatformInfo {
  userAgentData?: { platform?: string };
  platform?: string;
  maxTouchPoints?: number;
}

function fromName(name: string): OsName {
  const n = name.toLowerCase();
  if (n.startsWith('mac')) return 'macos';
  if (n.startsWith('win')) return 'windows';
  if (n.startsWith('linux')) return 'linux';
  return 'other';
}

export function detectOs(info?: PlatformInfo): OsName {
  const nav: PlatformInfo | undefined =
    info ?? (typeof navigator === 'undefined' ? undefined : (navigator as PlatformInfo));
  if (nav === undefined) return 'other';
  const hinted = nav.userAgentData?.platform;
  if (typeof hinted === 'string' && hinted !== '') return fromName(hinted);
  const platform = nav.platform ?? '';
  // An iPad reports MacIntel with a touch screen; it is not a Mac desktop.
  if (platform.startsWith('Mac') && (nav.maxTouchPoints ?? 0) > 1) return 'other';
  return fromName(platform);
}

/** Sets or clears `data-os` on <html> and returns the platform it found. */
export function applyOs(info?: PlatformInfo): OsName {
  const os = detectOs(info);
  const root = document.documentElement;
  if (os === 'other') root.removeAttribute('data-os');
  else root.setAttribute('data-os', os);
  return os;
}
