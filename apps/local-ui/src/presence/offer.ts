// WIN-HELLO-NATIVE / APP-CONTINUITY (S2; 04 §2.5 "Desktop app owner presence"; 08 §1 "One
// AgentLink, browser or app"): what a presence screen inside the desktop app offers, from
// GET /api/owner/native (native-api.ts). Platform-neutral, so every presence screen (first run,
// approvals, contacts, settings, New ID) uses it unchanged on macOS and Windows:
//   - `native`: Touch ID / Windows Hello (the app's helper; one OS gesture per owner operation),
//     only once it is on for this owner here (available, registered, no reason);
//   - `code`: the master code, with plain text on why native isn't offered and how to set it up
//     (WIN-HELLO-NATIVE's reasons when it isn't available) or turn it on (APP-CONTINUITY).
// Inside the app it is never the WebAuthn passkey path: a passkey made in the browser is not usable
// in the app's window, and on Windows without Windows Hello PRF that path only offers "Insert your
// security key" (WIN-FIRSTRUN-NOPRF). The server checks presence either way; this only decides
// what the page offers.
import type { DesktopPlatform } from './desktop.js';
import type { NativeStatus } from './native-api.js';
import { NATIVE_STRINGS } from './strings.js';

export type DesktopPresenceOffer =
  { readonly kind: 'native' } | { readonly kind: 'code'; readonly help: string };

export function desktopPresenceOffer(
  platform: DesktopPlatform,
  status: NativeStatus,
): DesktopPresenceOffer {
  if (status.available && status.registered && status.reason === undefined) {
    return { kind: 'native' };
  }
  // Not available on this computer: how to set it up (WIN-HELLO-NATIVE).
  if (!status.available) {
    return { kind: 'code', help: NATIVE_STRINGS.setUp(platform, status.unavailable ?? 'unknown') };
  }
  // Available but not on for this owner (or needing to be turned on again): how to turn it on.
  return { kind: 'code', help: NATIVE_STRINGS.codeHelp(platform, true) };
}
