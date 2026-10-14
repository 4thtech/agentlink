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

/** A test file: `*.test.<ext>`. LIBRARIES `testZones` apply to these files only. */
export const isTestFile = (file) => /\.test\.[cm]?[jt]sx?$/.test(file ?? '');

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
];

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
  'packages/node': entry(
    '@agentlink/node',
    ['core', 'log'],
    [
      {
        pattern: 'better-sqlite3',
        reason: 'SQLite Store; approved build script (pnpm-workspace.yaml)',
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
export const restrictedEntryMessage = (entry) =>
  `${entry.group[0]} may be imported only in ${entry.zones.join(', ')}; everything else uses ${entry.via}.`;
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
  for (const entry of RESTRICTED_ENTRY_POINTS) {
    if (matchesGroup(specifier, entry.group) && !entry.zones.includes(zone)) {
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
