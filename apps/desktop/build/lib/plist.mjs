// Info.plist and entitlements for the macOS bundle (written as text; no plist dependency).
// Derived from the Info.plist that ships in Electron 45.1.0, minus the camera/microphone/audio usage
// strings (the app never asks for them), plus our identity, agentlink:// and the ASAR integrity entry.
//
// TODO (untested, from the WP-D1 spike): Chromium logged "FIDO: Cannot use Bluetooth because the
// responsible app does not have Bluetooth metadata in its Info.plist". Phase 1 on macOS does not use
// a platform authenticator in the window, so NSBluetoothAlwaysUsageDescription is NOT added yet.
// Revisit (and test the hybrid/phone passkey path) before relying on it.

export const BUNDLE_ID = 'io.4thtech.agentlink';
export const APP_NAME = 'AgentLink';
export const URL_SCHEME = 'agentlink';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function infoPlist({ version, asarHash, minimumSystemVersion = '13.0' }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Bad version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(asarHash))
    throw new Error('asarHash must be 64 lowercase hex characters.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>${APP_NAME}.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${esc(version)}</string>
  <key>CFBundleVersion</key>
  <string>${esc(version)}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>AgentLink invite</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${URL_SCHEME}</string>
      </array>
    </dict>
  </array>
  <key>ElectronAsarIntegrity</key>
  <dict>
    <key>Resources/app.asar</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${asarHash}</string>
    </dict>
  </dict>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSEnvironment</key>
  <dict>
    <key>MallocNanoZone</key>
    <string>0</string>
  </dict>
  <key>LSMinimumSystemVersion</key>
  <string>${esc(minimumSystemVersion)}</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMainNibFile</key>
  <string>MainMenu</string>
  <key>NSPrincipalClass</key>
  <string>AtomApplication</string>
  <key>NSQuitAlwaysKeepsWindows</key>
  <false/>
  <key>NSRequiresAquaSystemAppearance</key>
  <false/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
`;
}

// Prepared and UNUSED today (ad-hoc builds are signed without entitlements). Used only when
// DESKTOP_SIGNING=on with a Developer ID and the hardened runtime (WP-D18). The keychain access
// group for the owner process is added there, on the app identity only, never on the bundled node.
export function entitlementsPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
`;
}
