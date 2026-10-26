import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from './tools/deps-check/eslint-plugin.mjs';
import {
  BUILTINS,
  CRYPTO_MSG,
  ENTRY_TEST_DIRS,
  LIBRARIES,
  NODE_MSG,
  RESTRICTED_ENTRY_POINTS,
  WORKSPACE_NAMES,
  ZONES,
  allowedWorkspaceNames,
  nodeBuiltinsAllowed,
  entryTestNames,
  layerMessage,
  libraryAllowed,
  libraryMessage,
  restrictedEntryMessage,
  deepImportGroup,
  deepImportMessage,
} from './tools/deps-check/policy.mjs';

const SOURCE = '{ts,tsx,mts,cts}';

// --- Import boundaries --------------------------------------------------------------------------
// The policy (which zone may import what) lives in tools/deps-check/policy.mjs and is shared with
// the deps-check script, which runs in `pnpm lint` and cannot be switched off by an inline comment.
//
// ESLint applies only the LAST matching `no-restricted-imports` block to a file, so each zone gets
// one block that holds its complete restriction list (built by restrictionsFor). Static imports are
// handled by no-restricted-imports; dynamic import(), require(), `import x = require()`, import()
// types, cross-package relative paths and `crypto.subtle` by the local boundaries/no-bypass rule.

function restrictionsFor(zone, { test = false, testDir = null } = {}) {
  const nodeAllowed = nodeBuiltinsAllowed(zone);
  const paths = nodeAllowed
    ? ['crypto', 'node:crypto'].map((name) => ({ name, message: CRYPTO_MSG }))
    : BUILTINS.map((name) => ({ name, message: NODE_MSG }));
  const patterns = nodeAllowed ? [] : [{ group: ['node:*'], message: NODE_MSG }];
  for (const lib of LIBRARIES) {
    if (zone !== null && libraryAllowed(lib, zone, { test })) continue;
    patterns.push({ group: lib.group, message: libraryMessage(lib) });
  }
  // Restricted subpaths of packages this zone may otherwise import (IR-M1-1b-1 M-1).
  // A test file of an entry's testZones may import its exact names only (M1-1g-b): ESLint gets the
  // group minus those names; boundaries/no-bypass and deps-check use policy.entryAllowed.
  for (const entry of RESTRICTED_ENTRY_POINTS) {
    if (zone !== null && entry.zones.includes(zone)) continue;
    const exact =
      zone !== null &&
      test &&
      ((entry.testZones ?? []).includes(zone) || (entry.testDirs ?? []).includes(testDir))
        ? entryTestNames(entry)
        : [];
    const group = entry.group.filter((pattern) => !exact.includes(pattern));
    patterns.push({ group, message: restrictedEntryMessage(entry) });
  }
  // Deep imports into any workspace package's dist/ or src/, in every zone (IR-M1-1f-1 L-2).
  for (const name of WORKSPACE_NAMES) {
    patterns.push({ group: deepImportGroup(name), message: deepImportMessage(name) });
  }
  // Package layering: every workspace package this zone may not import (apps are never importable).
  const allowed = allowedWorkspaceNames(zone);
  for (const name of WORKSPACE_NAMES) {
    if (allowed.includes(name)) continue;
    patterns.push({ group: [name, `${name}/*`], message: layerMessage(zone, name) });
  }
  return {
    'no-restricted-imports': ['error', { paths, patterns }],
    'boundaries/no-bypass': ['error', { zone }],
  };
}

// --- Console ban (M0-8) -------------------------------------------------------------------------
// The deliberate console channels; adding one is a reviewed change to this file (S1).
// - packages/log/src/console.ts: the logger's console sink. It only ever receives redacted lines.
// - apps/cli/src/output.ts: the CLI's user-output channel (command results such as `--version`).
//   It prints only what the user asked to see and is never used for logging.
// - packages/node/src/owner-terminal.ts: the owner prompt (M1-8c, 04 §2.8). It reads the owner code
//   from the process's own TTY and writes fixed copy and a newly generated code, once; never logs.
const CONSOLE_CHANNELS = [
  'packages/log/src/console.ts',
  'apps/cli/src/output.ts',
  'packages/node/src/owner-terminal.ts',
];
const CONSOLE_MESSAGE =
  'No console output: log through @4thtech-io/log (redacting). Deliberate channels: eslint.config.mjs CONSOLE_CHANNELS.';
const CONSOLE_SYNTAX = [
  // globalThis.console, window.console, (globalThis as T).console
  "MemberExpression[computed=false][property.name='console']",
  // globalThis['console']
  "MemberExpression[computed=true][property.value='console']",
  // declare const console: …; const console = …
  "VariableDeclarator[id.name='console']",
  // const { console } = globalThis
  "ObjectPattern > Property[key.name='console']",
  // import console from 'node:console'
  'ImportDeclaration[source.value=/^(node:)?console$/]',
  // process.stdout.write(…), globalThis.process.stderr.write(…)
  "MemberExpression[property.name=/^(stdout|stderr)$/][object.name='process']",
  "MemberExpression[property.name=/^(stdout|stderr)$/][object.property.name='process']",
].map((selector) => ({ selector, message: CONSOLE_MESSAGE }));
// Flat config replaces a rule's options instead of merging them: a later block that sets
// `no-restricted-syntax` for some files silently drops CONSOLE_SYNTAX there. Such a block must
// include ...CONSOLE_SYNTAX in its own list. tools/console-ban.test.mjs checks every zone.

// --- The runtime-agnostic tool module (06 §1, D-73 (1); M1-9c) ----------------------------------
// packages/mcp-tools/src/ (moved unchanged from apps/cli/src/tools/, M2-3t, G-15) is shared with the
// cloud agent, so it may import no Node built-in, nothing from @4thtech-io/node or the MCP SDK, and
// nothing outside src/ by a relative path; no dynamic import(), require or Node global. These are guards for
// portability and hygiene, not a security boundary (06 §1). The block keeps the package zone's own
// list (ESLint applies only the last matching no-restricted-imports block) and CONSOLE_SYNTAX.
const TOOLS_MSG =
  'packages/mcp-tools is runtime-agnostic (06 §1, D-73): no Node built-ins, @4thtech-io/node, MCP SDK or imports from outside src/.';

function toolModuleRestrictions(escapes) {
  const zone = restrictionsFor('packages/mcp-tools');
  const [, { paths, patterns }] = zone['no-restricted-imports'];
  return {
    ...zone,
    'no-restricted-imports': [
      'error',
      {
        paths: [...paths, ...BUILTINS.map((name) => ({ name, message: TOOLS_MSG }))],
        patterns: [
          ...patterns,
          { group: ['node:*'], message: TOOLS_MSG },
          { group: ['@4thtech-io/node', '@4thtech-io/node/*'], message: TOOLS_MSG },
          { group: ['@modelcontextprotocol/*'], message: TOOLS_MSG },
          { group: escapes, message: TOOLS_MSG },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...CONSOLE_SYNTAX,
      { selector: 'ImportExpression', message: TOOLS_MSG },
      { selector: "CallExpression[callee.name='require']", message: TOOLS_MSG },
      { selector: 'TSImportEqualsDeclaration', message: TOOLS_MSG },
    ],
    'no-restricted-globals': [
      'error',
      ...['process', 'Buffer', '__dirname', '__filename', 'require', 'module', 'global'].map(
        (name) => ({ name, message: TOOLS_MSG }),
      ),
    ],
  };
}

export default tseslint.config(
  {
    // Build output is ignored only where a build writes it (the root of a workspace), never at any
    // depth: `packages/core/src/dist/x.ts` is source and must be linted (boundary review IR-M0-10-1).
    ignores: [
      '**/node_modules/**',
      '{packages,apps,tools,e2e,test-vectors}/*/{dist,coverage,.turbo}/**',
      '{dist,coverage,.turbo}/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Never log secrets (AGENTS.md, 04 §8.4): no console output; log through @4thtech-io/log, which
    // redacts. Shared packages compile without DOM or Node types, so code reaches the console only
    // through globalThis or a local `declare const console`, and no-console sees neither:
    // CONSOLE_SYNTAX closes those routes. The only exceptions are the channels in CONSOLE_CHANNELS.
    rules: { 'no-console': 'error', 'no-restricted-syntax': ['error', ...CONSOLE_SYNTAX] },
  },
  {
    // Directories the policy does not know get the strictest set until they get an entry.
    files: [`packages/**/*.${SOURCE}`, `apps/**/*.${SOURCE}`],
    plugins: { boundaries },
    // eval, new Function and string timers build code the import checks cannot see.
    rules: {
      ...restrictionsFor(null),
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  // e2e/ (M1-1g-c): never built, may use the test seam, but its suites touch real crypto paths.
  // Same libraries, /keystore, Node crypto, crypto.subtle, deep-import and scope rules as any zone;
  // Node built-ins allowed except crypto; every workspace package importable by name.
  {
    files: [`e2e/**/*.${SOURCE}`],
    plugins: { boundaries },
    rules: {
      ...restrictionsFor('e2e'),
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  ...Object.keys(ZONES).map((zone) => ({
    files: [`${zone}/**/*.${SOURCE}`],
    rules: restrictionsFor(zone),
  })),
  // Test files of zones with test-only libraries or entry points (LIBRARIES and RESTRICTED_ENTRY_POINTS
  // testZones; IR-M1-1e-1 L-1, M1-1g-b). This block comes after the zone's own, so it is the one
  // no-restricted-imports block that applies to them. Only *.test.ts, the one name every build
  // excludes (policy.isTestFile, IR-M1-1c-G2-1 L-1): a .test.mts keeps the production rules.
  ...[
    ...new Set([...LIBRARIES, ...RESTRICTED_ENTRY_POINTS].flatMap((item) => item.testZones ?? [])),
  ].map((zone) => ({
    files: [`${zone}/**/*.test.ts`],
    rules: restrictionsFor(zone, { test: true }),
  })),
  // Test files of an entry's testDirs only (IR-M1-9k-1 F01): `apps/cli/test/**/*.test.ts` may import
  // the crypto test seam by name; apps/cli/src (production and tests) keeps the production rules.
  ...ENTRY_TEST_DIRS.map((dir) => ({
    files: [`${dir}/**/*.test.ts`],
    rules: restrictionsFor(Object.keys(ZONES).find((zone) => dir.startsWith(`${zone}/`)) ?? null, {
      test: true,
      testDir: dir,
    }),
  })),
  // The address-checked RPC fetch brand (IR-M1-4a-2 R-3, M1-4b): @4thtech-io/chain createReadClient
  // builds a client only over a fetch that carries a registered-symbol brand, which only
  // @4thtech-io/node nodeRpcFetch (the 04 §4 resolve-time check) sets. Production code may not call
  // Symbol.for anywhere else, so it cannot brand a plain fetch by mistake. The rule names the
  // property only, so an alias (`const S = Symbol; S['for'](…)`) and a computed member are refused
  // too (IR-M1-4b-1 L-1). A guard against wiring mistakes, not against a malicious in-process
  // caller; tests may brand their fakes.
  {
    files: [`packages/**/*.${SOURCE}`, `apps/**/*.${SOURCE}`],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'for',
          message:
            'Symbol.for is reserved for the address-checked RPC fetch brand (packages/node/src/rpc-fetch.ts, packages/chain/src/clients/checked-fetch.ts).',
        },
      ],
    },
  },
  {
    files: [
      'packages/node/src/rpc-fetch.ts',
      'packages/chain/src/clients/checked-fetch.ts',
      '**/*.test.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
  // The tool module's fence (above): files directly in src/ may not go up a level, files in
  // its subfolders not two levels.
  {
    files: [`packages/mcp-tools/src/*.${SOURCE}`],
    rules: toolModuleRestrictions(['../*', '../**']),
  },
  {
    files: [`packages/mcp-tools/src/*/**/*.${SOURCE}`],
    rules: toolModuleRestrictions(['../../*', '../../**']),
  },
  {
    // Node-only code gets Node globals: build tooling, config files and tests (which run in Node).
    // Shared packages get none. The repository scripts under tools/ and the CI check scripts under
    // apps/cli/scripts/ (never published: `files` names only dist/agentlink.js) print to the terminal.
    files: [
      'tools/**',
      'apps/cli/scripts/**/*.mjs',
      '**/*.test.ts',
      '**/*.config.{ts,mjs}',
      'eslint.config.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The console channels and the repository scripts. This turns off ALL no-restricted-syntax
    // selectors for these files, not only CONSOLE_SYNTAX: keep the list to these exact paths.
    files: ['tools/**', 'apps/cli/scripts/**/*.mjs', ...CONSOLE_CHANNELS],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
);
