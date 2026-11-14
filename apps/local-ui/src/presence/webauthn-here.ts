// APP-CONTINUITY (owner requirement 14 Nov; 08 §1 "One AgentLink, browser or app"; 04 §2.5): the
// one place a page asks "may I use WebAuthn here?". Inside the desktop app's window the answer is
// always no: a passkey made in the browser is not usable there, and on Windows a WebAuthn call can
// end on "Insert your security key". The app's own Touch ID / Windows Hello (native-api.ts) or the
// master code is offered instead (offer.ts). In a browser nothing changes.
//
// This only decides what the page offers and calls; it grants nothing. The server checks presence
// either way (04 §2.5), so a page that lies about where it runs gains nothing.

/** The desktop app's user-agent marker (desktop.ts DESKTOP_MARKER), as a whole word. */
const MARKER = /(?:^|\s)AgentLinkDesktop\/1(?:\s|$)/;

const agent = (userAgent?: string): string =>
  userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);

/** True inside the desktop app's window (any platform). */
export function inAppWindow(userAgent?: string): boolean {
  return MARKER.test(agent(userAgent));
}

/** True when this page may use WebAuthn: a browser that has it, never the desktop app's window. */
export function webAuthnHere(userAgent?: string): boolean {
  if (inAppWindow(userAgent)) return false;
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
}

/** navigator.credentials where WebAuthn may be used here; undefined in the desktop app's window. */
export function pageCredentials(userAgent?: string): CredentialsContainer | undefined {
  if (inAppWindow(userAgent)) return undefined;
  return typeof navigator === 'undefined' ? undefined : navigator.credentials;
}
