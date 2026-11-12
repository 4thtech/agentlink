// The release fuse set (Decision 3 / H1). Names match @electron/fuses FuseV1Options.
export const FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};

// Index in the fuse wire -> name (mirror of FuseV1Options; check-fuses cross-checks it).
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

// Not part of the pinned set (a V8 crash handler, no authority); any value is accepted.
const UNPINNED = new Set(['WasmTrapHandlers']);

/** `actual` is {name: boolean}. Returns one line per fuse that differs, is missing or is unknown. */
export function diffFuses(actual) {
  const out = [];
  for (const [name, want] of Object.entries(FUSES)) {
    if (!(name in actual)) out.push(`${name}: missing (expected ${want})`);
    else if (actual[name] !== want) out.push(`${name}: is ${actual[name]}, expected ${want}`);
  }
  for (const name of Object.keys(actual)) {
    if (!(name in FUSES) && !UNPINNED.has(name)) {
      out.push(`${name}: unknown fuse (new in this Electron? decide and pin it)`);
    }
  }
  return out;
}
