// Architecture boundary policy: the single source of truth for who may import and depend on what.
//
// Read by three consumers, so they cannot drift apart:
//   - eslint.config.mjs   (no-restricted-imports zones and the boundaries/no-bypass rule),
//   - tools/deps-check/   (manifest and source scan; CI runs it through `pnpm lint`),
//   - their tests.
//
// Specs: 04 §8.1 (crypto allowlist), 07 §1 (package map), development-process.md §11,
// AGENTS.md Hard rules, backlog M0-10.
//
// CHANGING THIS FILE IS A REVIEWED SECURITY CHANGE (S1). Widening a zone, a layering entry or the
// runtime-dependency allowlist must be justified in the PR. Every external entry carries a `reason`
// line so the reviewer sees the justification in the diff.

import { builtinModules } from 'node:module';

/** Node built-ins (bare and `node:`) are allowed only here (repo-reference.md, 11 §6). */
export const NODE_ZONES = ['packages/node', 'apps/cli'];

/** Built-ins that exist only with the prefix (node:test, node:sqlite) are covered by `node:`. */
export const BUILTINS = builtinModules.filter((name) => !name.startsWith('node:'));

/**
 * Crypto and transport libraries (04 §8.1): our code reaches primitives only through
 * @agentlink/crypto. Each library may be used only by the zones that 07 §1 names as its consumer.
 * `apps/pay` is the deposit page on the isolated `pay.` origin (08 §2.3, M2-2f); it does not exist yet.
 */
export const LIBRARIES = [
  { group: ['@noble/*'], zones: ['packages/crypto'], via: '@agentlink/crypto' },
  { group: ['@hpke/*'], zones: ['packages/crypto'], via: '@agentlink/crypto' },
  {
    group: ['nostr-tools', 'nostr-tools/*'],
    zones: ['packages/crypto', 'packages/transport-nostr'],
    via: '@agentlink/transport-nostr',
  },
  {
    group: ['viem', 'viem/*'],
    zones: ['packages/chain', 'apps/pay'],
    via: '@agentlink/chain',
    // Tests only (IR-M1-1e-1 L-1): @agentlink/crypto implements EIP-712 on noble (07 §1) and uses
    // viem as an independent oracle in its *.test.ts files, as a devDependency. Runtime source and
    // runtime dependencies of packages/crypto may not use it.
    testZones: ['packages/crypto'],
  },
  { group: ['aws4fetch'], zones: ['packages/storage'], via: '@agentlink/storage' },
  {
    // Other crypto libraries are not on the 04 §8.1 allowlist: no zone may use them. Adding one is a
    // decision (D-xx) with the owner's approval, then an entry here.
    group: [
      'tweetnacl',
      'ethers',
      'elliptic',
      'crypto-js',
      'node-forge',
      'libsodium',
      'libsodium-wrappers',
      'libsodium-wrappers-sumo',
      'sodium-native',
      'js-sha3',
      'hash-wasm',
      'ethereum-cryptography',
      'ethereum-cryptography/*',
      '@scure/*',
    ],
    zones: [],
    via: '@agentlink/crypto',
  },
];

/**
 * A test file: exactly `*.test.ts`. LIBRARIES and RESTRICTED_ENTRY_POINTS `testZones` apply to these
 * files only. Every package build excludes exactly `src/**\/*.test.ts` (tsconfig.json), so any other
 * test-like name (`.test.mts`, `.test.cts`, `.test.tsx`, `.test.js`, `.spec.*`) would be built into
 * dist/: it counts as production code here, and deps-check reports it (IR-M1-1c-G2-1 L-1).
 */
export const isTestFile = (file) => /\.test\.ts$/.test(file ?? '');

/** A file name test runners pick up as a test: `<name>.test.<ext>` or `<name>.spec.<ext>`. */
const TEST_LIKE = /\.(?:test|spec)\.[^/\\.]+$/;

export const MISNAMED_TEST_MESSAGE =
  'test files are named *.test.ts: package builds exclude only that name, so this file would be built into dist/ and counts as production code (IR-M1-1c-G2-1 L-1); rename it';

/** The message for a test-like file name that is not `*.test.ts`, or null. */
export const misnamedTestFile = (file) =>
  TEST_LIKE.test(file ?? '') && !isTestFile(file) ? MISNAMED_TEST_MESSAGE : null;

/** True when `lib` may be used in `zone`: everywhere in its zones, in tests only in its testZones. */
export const libraryAllowed = (lib, zone, { test = false } = {}) =>
  lib.zones.includes(zone) || (test && (lib.testZones ?? []).includes(zone));

/**
 * Restricted entry points of workspace packages (IR-M1-1b-1 M-1). A zone that may import the package
 * may still not import these subpaths unless it is listed. `@agentlink/crypto/keystore` holds every
 * function that takes a master seed or a secret key (04 §8.1: secret-key operations go through the
 * KeyStore interface; 04 §2.5: the agent may run shell commands as the same user), so only the zones
 * that host KeyStore backends may import it: packages/node (the file and keychain backends) and the
 * vector harness (test-vectors, which has no layering entry and gets its rules from its own ESLint
 * config). The package layering below still applies on top: packages/node does not list `crypto`
 * in its `uses` yet, so the card that adds the backends widens that entry. Widening a zone here is a
 * reviewed S1 change with a reason.
 */
export const RESTRICTED_ENTRY_POINTS = [
  {
    group: ['@agentlink/crypto/keystore', '@agentlink/crypto/keystore/*'],
    zones: ['packages/node', 'test-vectors'],
    via: 'the KeyStore interface (04 §8.1)',
    reason: 'master seeds and secret keys stay inside KeyStore backends (04 §8.1, §2.5)',
  },
  // M1-1c, M1-1f, M1-1g: the deterministic test seam (fixed AES-GCM nonce or IV, fixed HPKE
  // ephemeral key, Argon2id with a secret value and associated data) and the test doubles
  // MemoryKeyStore and MemoryOwnerKeyStore. It is never built and has no package export; only a
  // Vitest alias and a noEmit tsconfig.test.json `paths` entry resolve it (test-vectors,
  // packages/core, packages/transport-nostr). This entry refuses it by name everywhere else.
  // 04 §3.1.1: an entry point "that deps-check allows only in tests, test-vectors and e2e, never in
  // production src". `zones` are the test-only directories (never built or published); `testZones`
  // are the packages whose *.test.ts files may import the exact name `@agentlink/crypto/testing`
  // (M1-1g-b, IR-M1-1g-G2-1 R2-L-1): transport-nostr for M1-5a and core for M1-7a. packages/crypto's
  // own tests use the relative path (TEST_SEAM_SOURCE). Another package's tests: add it here (S1).
  {
    group: ['@agentlink/crypto/testing', '@agentlink/crypto/testing/*'],
    zones: ['test-vectors', 'e2e'],
    testZones: ['packages/core', 'packages/transport-nostr'],
    via: 'the public entry points (the test seam is never built)',
    reason:
      'a fixed nonce, IV or ephemeral key, or an in-memory seed holder, must never reach production code (M1-1c, M1-1f, M1-1g)',
  },
];

/**
 * True when `entry` (RESTRICTED_ENTRY_POINTS) may be used in `zone`: everywhere in its zones; in a
 * test file of its testZones, by an exact (non-`/*`) name of its group only, never a subpath.
 */
export function entryAllowed(entry, zone, specifier, { test = false } = {}) {
  if (entry.zones.includes(zone)) return true;
  return (
    test &&
    (entry.testZones ?? []).includes(zone) &&
    entry.group.some((pattern) => !pattern.endsWith('/*') && pattern === specifier)
  );
}

/** The exact names of `entry` that its testZones' test files may import (ESLint needs them apart). */
export const entryTestNames = (entry) =>
  (entry.testZones ?? []).length === 0 ? [] : entry.group.filter((p) => !p.endsWith('/*'));

/**
 * The test seam's source file (M1-1c, M1-1f), without extension. RESTRICTED_ENTRY_POINTS refuses
 * `@agentlink/crypto/testing` by name; inside packages/crypto a relative path reaches the file too.
 * Only test files may import it: tsc builds every file that a built module imports (tsconfig
 * `exclude` only limits the roots), so one production import would also put the seam into dist/.
 */
export const TEST_SEAM_SOURCE = 'packages/crypto/src/testing';

export const TEST_SEAM_MESSAGE =
  'packages/crypto/src/testing.ts (the test seam) may be imported only by test files (*.test.ts) and test-vectors; production code uses the public functions (M1-1c, M1-1f)';

/**
 * The message for a relative import from `file` (repo path) that resolves to `target` (repo path),
 * or null when it is not the test seam or `file` is a test file.
 */
export function testSeamViolation(file, target) {
  if (target.replace(/\.[cm]?[jt]sx?$/, '') !== TEST_SEAM_SOURCE) return null;
  return isTestFile(file) ? null : TEST_SEAM_MESSAGE;
}

/**
 * Files that may import `node:module` (createRequire can resolve code from another package's
 * directory). Each entry needs a reason. Empty: nothing needs it today.
 */
export const NODE_MODULE_FILES = [];

/** Property names that reach Node's module loader or native bindings around the import checks. */
export const LOADER_MEMBERS = ['getBuiltinModule', '_linkedBinding', 'dlopen', 'mainModule'];

/** Only this zone may touch `crypto.subtle` (backlog M0-10). */
export const SUBTLE_ZONES = ['packages/crypto'];

/**
 * Directories outside packages/* and apps/* that deps-check scans for `crypto.subtle` only (their own
 * ESLint config and the vector harness rules cover the rest). test-vectors/ is owned by M0-9.
 */
export const SUBTLE_ONLY_ZONES = ['test-vectors'];

/**
 * Files outside packages/crypto that may use `crypto.subtle`, each with a reason. Exact paths from the
 * repository root; keep this list as short as possible.
 */
export const SUBTLE_EXEMPT_FILES = [
  {
    file: 'test-vectors/harness/suites/placeholder-sha256.ts',
    reason:
      "M0-9 placeholder suite: it tests the runtime's own SHA-256 against NIST/RFC values before @agentlink/crypto exists. Remove when the first real suite lands.",
  },
];

export const isSubtleExempt = (file) => SUBTLE_EXEMPT_FILES.some((entry) => entry.file === file);

// --- Layering -------------------------------------------------------------------------------------
// `uses` lists the workspace packages (by directory name under packages/) that a zone may import AND
// declare as a dependency. Importing your own package by name is always fine. The graph must stay
// acyclic (the tests assert it), and nothing imports an app.
//
// 07 §1 lists no `types` for transport-nostr and storage. They need it for Envelope and StoredObject,
// so they get it. crypto stays minimal on purpose: it is the trusted base.

const ALL_PACKAGES = [
  'types',
  'log',
  'crypto',
  'chain',
  'transport-nostr',
  'storage',
  'core',
  'node',
  'ui',
];
const NO_NODE = ALL_PACKAGES.filter((name) => name !== 'node'); // only the CLI and desktop host Node code
const WORKER_APP = NO_NODE.filter((name) => name !== 'ui'); // Workers: no React UI

const entry = (name, uses, external = []) => ({ name, uses, external });

/**
 * Zone (directory) -> { name, uses, external }.
 * `external` is the runtime-dependency allowlist (`dependencies`, `peerDependencies`,
 * `optionalDependencies`): anything else a package declares fails deps-check. A new entry needs a
 * `reason` that reviewers see in the diff. devDependencies are not runtime and are not allowlisted
 * (the primitive-library ban still applies to them).
 */
export const ZONES = {
  'packages/types': entry(
    '@agentlink/types',
    [],
    [{ pattern: 'zod', reason: 'schemas for the shared types (07 §1)' }],
  ),
  // The redacting logger (M0-8): zero dependencies, imports nothing, usable by every package that
  // does I/O. types, crypto and ui do not log (yet); widening that is a reviewed change.
  'packages/log': entry('@agentlink/log', []),
  'packages/crypto': entry(
    '@agentlink/crypto',
    [],
    [
      { pattern: '@noble/*', reason: 'the only package that implements primitives (04 §8.1)' },
      {
        pattern: '@hpke/core',
        reason: 'HPKE seal/open; only @hpke/core is on the 04 §8.1 allowlist',
      },
    ],
  ),
  'packages/chain': entry(
    '@agentlink/chain',
    ['types', 'log', 'crypto'],
    [
      { pattern: 'viem', reason: 'chain clients and OCC v2 bindings (07 §1)' },
      { pattern: 'viem/*', reason: 'viem subpath exports (chains, actions)' },
      {
        pattern: '@agentlink/occ-v2-abi',
        reason: 'contract ABIs; the Solidity source stays private',
      },
    ],
  ),
  'packages/transport-nostr': entry(
    '@agentlink/transport-nostr',
    ['types', 'log', 'crypto'],
    [
      { pattern: 'nostr-tools', reason: 'relay pool and NIP-17/59 plumbing (07 §1)' },
      { pattern: 'nostr-tools/*', reason: 'nostr-tools subpath exports' },
    ],
  ),
  'packages/storage': entry(
    '@agentlink/storage',
    ['types', 'log', 'crypto'],
    [{ pattern: 'aws4fetch', reason: 'S3-compatible presigning for the s3 adapter (07 §1)' }],
  ),
  'packages/core': entry('@agentlink/core', [
    'types',
    'log',
    'crypto',
    'chain',
    'transport-nostr',
    'storage',
  ]),
  // M1-8a: `crypto` for the KeyStore interface and its restricted /keystore entry (the backends).
  'packages/node': entry(
    '@agentlink/node',
    ['core', 'log', 'crypto'],
    [
      {
        pattern: 'better-sqlite3',
        reason:
          'SQLite Store (07 §3.7, M1-8b); prebuilt binaries in the package, no install script',
      },
      {
        pattern: '@napi-rs/keyring',
        reason:
          'OS keychain KeyStore (03 §6, 04 §2.2, M1-8a); prebuilt platform packages, no install script',
      },
    ],
  ),
  'packages/ui': entry(
    '@agentlink/ui',
    ['types'],
    [
      { pattern: 'react', reason: 'component library (03 §tech stack)' },
      { pattern: 'react-dom', reason: 'component library (03 §tech stack)' },
    ],
  ),
  'apps/cli': entry('@4thtech/agentlink', ALL_PACKAGES, [
    { pattern: '@modelcontextprotocol/sdk', reason: 'MCP stdio server (repo-reference.md, stack)' },
  ]),
  'apps/console': entry('@agentlink/console', NO_NODE),
  'apps/verify': entry('@agentlink/verify', NO_NODE),
  'apps/invite': entry('@agentlink/invite', NO_NODE),
  'apps/pay': entry('@agentlink/pay', NO_NODE),
  'apps/cloud-agent': entry('@agentlink/cloud-agent', WORKER_APP),
  'apps/submitter': entry('@agentlink/submitter', WORKER_APP),
  'apps/drop': entry('@agentlink/drop', WORKER_APP),
};

/** Every workspace package name known to the policy. */
export const WORKSPACE_NAMES = Object.values(ZONES).map(({ name }) => name);

/** Allowed workspace package names for a zone (its own name included). */
export function allowedWorkspaceNames(zone) {
  const found = ZONES[zone];
  if (!found) return [];
  return [found.name, ...found.uses.map((short) => ZONES[`packages/${short}`].name)];
}

const matchesEntry = (specifier, pattern) =>
  pattern.endsWith('/*') ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern;

/** True when `specifier` matches one of the patterns (`a/*` prefix form, or exact). */
export const matchesGroup = (specifier, group) =>
  group.some((pattern) => matchesEntry(specifier, pattern));

/** The workspace package name an import specifier refers to, or null. */
export function workspaceNameOf(specifier) {
  return (
    WORKSPACE_NAMES.find((name) => specifier === name || specifier.startsWith(`${name}/`)) ?? null
  );
}

export function isBuiltin(specifier) {
  return specifier.startsWith('node:') || BUILTINS.includes(specifier);
}

/** True for the Node crypto module (`crypto`, `node:crypto`, `crypto/...`). */
export const isNodeCrypto = (specifier) => /^(node:)?crypto(\/|$)/.test(specifier);

export const NODE_MSG = 'Node built-ins are allowed only in @agentlink/node and apps/cli.';
export const CRYPTO_MSG =
  'Node crypto is a primitive entry point; use @agentlink/crypto (AGENTS.md hard rules).';
export const libraryMessage = (lib) =>
  lib.zones.length === 0
    ? `${lib.group[0]} is not on the crypto allowlist (04 §8.1); adding a library needs a decision and the owner's approval.`
    : `${lib.group[0]} may be imported only in ${lib.zones.join(', ')}${
        lib.testZones?.length ? ` (and in test files of ${lib.testZones.join(', ')})` : ''
      }; everything else uses ${lib.via} (AGENTS.md).`;
/**
 * Deep imports into a workspace package (IR-M1-1f-1 L-2): `<package>/dist…` or `<package>/src…`
 * reach modules the package's `exports` map does not publish (for example the fixed-nonce sealers in
 * dist/keystore-file.js, or the restricted keystore functions by another path), so they are refused
 * in every zone. Packages are imported by their name and their declared subpaths only.
 */
export const DEEP_IMPORT_DIRS = ['dist', 'src'];

/** The ESLint `group` patterns for the deep imports of one workspace package. */
export const deepImportGroup = (name) =>
  DEEP_IMPORT_DIRS.flatMap((dir) => [`${name}/${dir}`, `${name}/${dir}/*`]);

/**
 * True when `specifier` is a deep import into the workspace package `name`: its first segment is
 * dist/ or src/, or any segment is `.` or `..` (`<pkg>/testing/../src/x` names a file by path).
 */
export function isDeepImport(name, specifier) {
  if (!specifier.startsWith(`${name}/`)) return false;
  const segments = specifier.slice(name.length + 1).split('/');
  return (
    DEEP_IMPORT_DIRS.includes(segments[0]) ||
    segments.some((segment) => segment === '..' || segment === '.')
  );
}

/** The npm scopes of the workspace packages (`@agentlink/`, `@4thtech/`). */
const WORKSPACE_SCOPES = [...new Set(WORKSPACE_NAMES.map((name) => `${name.split('/')[0]}/`))];

/**
 * True for a specifier in a workspace scope that is not in canonical form (IR-M1-1g-b-1 L-2): an
 * upper-case letter, or an empty, `.` or `..` segment (`@agentlink/crypto//testing`,
 * `@agentlink/crypto/Testing`, `@agentlink/crypto/./testing`, a trailing `/`). The policy matches
 * exact, lower-case names; a case-insensitive file system or a lenient resolver could map such a
 * spelling onto a restricted entry point, so every guard refuses it outright.
 */
export function isNonCanonicalWorkspaceSpecifier(specifier) {
  const lower = specifier.toLowerCase();
  if (!WORKSPACE_SCOPES.some((scope) => lower.startsWith(scope))) return false;
  return (
    specifier !== lower ||
    specifier.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

export const nonCanonicalMessage = (specifier) =>
  `"${specifier}" is a non-canonical specifier for a workspace package (upper case, or an empty, "." or ".." segment); import the package by its exact name or a subpath its package.json "exports" declares (IR-M1-1g-b-1 L-2).`;

export const deepImportMessage = (name) =>
  `${name}: deep import into the package's build or sources is not allowed; import ${name} or a subpath its package.json "exports" declares (IR-M1-1f-1 L-2).`;

export const restrictedEntryMessage = (entry) =>
  `${entry.group[0]} may be imported only in ${entry.zones.join(', ')}${
    entry.testZones?.length
      ? ` (and by that exact name in *.test.ts files of ${entry.testZones.join(', ')})`
      : ''
  }; everything else uses ${entry.via}.`;
export const layerMessage = (zone, name) =>
  ZONES[zone]
    ? `${zone} may not import ${name} (package layering: tools/deps-check/policy.mjs, 07 §1).`
    : `${name} is not allowed here: this directory has no entry in tools/deps-check/policy.mjs.`;

/**
 * The one decision function for a non-relative import specifier. Returns a message when `zone` (a key
 * of ZONES, or null for a directory the policy does not know) may NOT use `specifier` in `file`
 * (path relative to the repository root), else null.
 * eslint.config.mjs derives its static zones from the same data.
 */
export const MODULE_MSG =
  'node:module (createRequire) is allowed only in the files listed in NODE_MODULE_FILES (tools/deps-check/policy.mjs).';

export function violationFor(zone, specifier, file) {
  if (isBuiltin(specifier)) {
    if (!NODE_ZONES.includes(zone)) return NODE_MSG;
    if (isNodeCrypto(specifier)) return CRYPTO_MSG;
    if (/^(node:)?module$/.test(specifier) && !NODE_MODULE_FILES.some((f) => f.file === file)) {
      return MODULE_MSG;
    }
    return null;
  }
  if (isNonCanonicalWorkspaceSpecifier(specifier)) return nonCanonicalMessage(specifier);
  const workspace = workspaceNameOf(specifier);
  if (workspace !== null && isDeepImport(workspace, specifier)) return deepImportMessage(workspace);
  for (const entry of RESTRICTED_ENTRY_POINTS) {
    if (
      matchesGroup(specifier, entry.group) &&
      !entryAllowed(entry, zone, specifier, { test: isTestFile(file) })
    ) {
      return restrictedEntryMessage(entry);
    }
  }
  for (const lib of LIBRARIES) {
    if (
      matchesGroup(specifier, lib.group) &&
      !libraryAllowed(lib, zone, { test: isTestFile(file) })
    ) {
      return libraryMessage(lib);
    }
  }
  const name = workspaceNameOf(specifier);
  if (name !== null && !allowedWorkspaceNames(zone).includes(name)) {
    return layerMessage(zone, name);
  }
  return null;
}
