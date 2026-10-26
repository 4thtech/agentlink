// M1-9f (D-91): fills the Claude Desktop extension manifest template
// (apps/cli/desktop-extension/manifest.json, MCPB manifest_version 0.3) for one release and one
// platform. The bundle is self-contained: per-platform native modules (@napi-rs/keyring,
// better-sqlite3), so one bundle per operating system and CPU.

export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** Bundle targets: name -> npm `--os` / `--cpu` and the manifest platform. Claude Desktop runs on macOS and Windows. */
export const TARGETS = Object.freeze({
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'win32-x64': { os: 'win32', cpu: 'x64' },
});

/** The manifest for `version` (a stable npm version) and `target` (a TARGETS key). */
export function buildManifest(template, { version, target }) {
  if (!VERSION_RE.test(version ?? ''))
    throw new Error('version must be a stable x.y.z npm version');
  const t = Object.hasOwn(TARGETS, target) ? TARGETS[target] : undefined;
  if (!t) throw new Error(`unknown target (expected one of ${Object.keys(TARGETS).join(', ')})`);
  const manifest = structuredClone(template);
  manifest.version = version;
  manifest.compatibility = { ...manifest.compatibility, platforms: [t.os] };
  return manifest;
}
