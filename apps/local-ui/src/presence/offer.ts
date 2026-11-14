// WIN-HELLO-NATIVE (S2; 04 §2.5 "Desktop app owner presence"): what a presence screen inside the
// desktop app offers, from GET /api/owner/native (native-api.ts). Platform-neutral, so the first-run
// and approval screens use it unchanged on macOS and Windows:
//   - `native`: Touch ID / Windows Hello (the app's helper; one OS gesture per owner operation);
//   - `code`: the master code, with plain text on why native isn't offered and how to set it up.
// Inside the app it is never the WebAuthn passkey path: on Windows without Windows Hello PRF that
// path only offers "Insert your security key" (WIN-FIRSTRUN-NOPRF), so the page never falls through
// to it. The server checks presence either way; this only decides what the page offers.
import type { DesktopPlatform } from './desktop.js';
import type { NativeStatus } from './native-api.js';
import { NATIVE_STRINGS } from './strings.js';

export type DesktopPresenceOffer =
  { readonly kind: 'native' } | { readonly kind: 'code'; readonly help: string };

export function desktopPresenceOffer(
  platform: DesktopPlatform,
  status: NativeStatus,
): DesktopPresenceOffer {
  if (status.available) return { kind: 'native' };
  return { kind: 'code', help: NATIVE_STRINGS.setUp(platform, status.unavailable ?? 'unknown') };
}
