import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from './tools/deps-check/eslint-plugin.mjs';
import {
  BUILTINS,
  CRYPTO_MSG,
  LIBRARIES,
  NODE_MSG,
  NODE_ZONES,
  RESTRICTED_ENTRY_POINTS,
  TEST_FILE_GLOBS,
  TEST_ONLY_ENTRY_POINTS,
  WORKSPACE_NAMES,
  ZONES,
  allowedWorkspaceNames,
  layerMessage,
  libraryMessage,
  restrictedEntryMessage,
  testOnlyEntryMessage,
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

function restrictionsFor(zone, { testFile = false } = {}) {
  const nodeAllowed = NODE_ZONES.includes(zone);
  const paths = nodeAllowed
    ? ['crypto', 'node:crypto'].map((name) => ({ name, message: CRYPTO_MSG }))
    : BUILTINS.map((name) => ({ name, message: NODE_MSG }));
  const patterns = nodeAllowed ? [] : [{ group: ['node:*'], message: NODE_MSG }];
  for (const lib of LIBRARIES) {
    if (zone !== null && lib.zones.includes(zone)) continue;
    patterns.push({ group: lib.group, message: libraryMessage(lib) });
  }
  // Restricted subpaths of packages this zone may otherwise import (IR-M1-1b-1 M-1).
  for (const entry of RESTRICTED_ENTRY_POINTS) {
    if (zone !== null && entry.zones.includes(zone)) continue;
    patterns.push({ group: entry.group, message: restrictedEntryMessage(entry) });
  }
  // Test-only subpaths (IR-M1-1g-1 M-2): refused everywhere except in test files.
  if (!testFile) {
    for (const entry of TEST_ONLY_ENTRY_POINTS) {
      patterns.push({ group: entry.group, message: testOnlyEntryMessage(entry) });
    }
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
const CONSOLE_CHANNELS = ['packages/log/src/console.ts', 'apps/cli/src/output.ts'];
const CONSOLE_MESSAGE =
  'No console output: log through @agentlink/log (redacting). Deliberate channels: eslint.config.mjs CONSOLE_CHANNELS.';
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
    // Never log secrets (AGENTS.md, 04 §8.4): no console output; log through @agentlink/log, which
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
  ...Object.keys(ZONES).map((zone) => ({
    files: [`${zone}/**/*.${SOURCE}`],
    rules: restrictionsFor(zone),
  })),
  // Test files of each zone: the same list without the test-only subpaths. It must come after the
  // zone blocks, because ESLint applies only the last matching no-restricted-imports block.
  ...Object.keys(ZONES).map((zone) => ({
    files: TEST_FILE_GLOBS.map((glob) => `${zone}/${glob}`),
    rules: restrictionsFor(zone, { testFile: true }),
  })),
  {
    // Node-only code gets Node globals: build tooling, config files and tests (which run in Node).
    // Shared packages get none. The repository scripts under tools/ print to the terminal.
    files: ['tools/**', '**/*.test.ts', '**/*.config.{ts,mjs}', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The console channels and the repository scripts. This turns off ALL no-restricted-syntax
    // selectors for these files, not only CONSOLE_SYNTAX: keep the list to these exact paths.
    files: ['tools/**', ...CONSOLE_CHANNELS],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
);
