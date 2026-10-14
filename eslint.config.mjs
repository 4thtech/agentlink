import { builtinModules } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SOURCE = '{ts,tsx,mts,cts}';

// --- Import boundaries --------------------------------------------------------------------------
// ESLint applies only the LAST matching `no-restricted-imports` block to a file, so each zone gets
// one block that holds its complete restriction list (built by restrictionsFor).

// Node built-ins (bare and `node:`) are allowed only in @agentlink/node and apps/cli
// (docs/process/repo-reference.md): shared packages run in Node, browsers and Workers.
const NODE_ZONES = ['packages/node', 'apps/cli'];
// Built-ins that exist only with the prefix (node:test, node:sqlite) are covered by the node:* pattern.
const BUILTINS = builtinModules.filter((name) => !name.startsWith('node:'));

// Crypto and transport libraries (AGENTS.md hard rules, 04 §8): our code reaches primitives only
// through @agentlink/crypto. Each library may be imported only by the zones that 07 §1 names as its
// consumer. Widening an entry is a reviewed change to this file (S1).
const LIBRARIES = [
  { group: ['@noble/*'], zones: ['packages/crypto'] },
  { group: ['@hpke/*'], zones: ['packages/crypto'] },
  {
    group: ['nostr-tools', 'nostr-tools/*'],
    zones: ['packages/crypto', 'packages/transport-nostr'],
  },
  { group: ['viem', 'viem/*'], zones: ['packages/crypto', 'packages/chain', 'apps/submitter'] },
  { group: ['aws4fetch'], zones: ['packages/storage'] },
];

function restrictionsFor(zone) {
  const nodeAllowed = zone !== null && NODE_ZONES.includes(zone);
  const paths = nodeAllowed
    ? []
    : BUILTINS.map((name) => ({
        name,
        message: 'Node built-ins are allowed only in @agentlink/node and apps/cli.',
      }));
  const patterns = nodeAllowed
    ? []
    : [
        {
          group: ['node:*'],
          message: 'Node built-ins are allowed only in @agentlink/node and apps/cli.',
        },
      ];
  for (const { group, zones } of LIBRARIES) {
    if (zone !== null && zones.includes(zone)) continue;
    patterns.push({
      group,
      message: `${group[0]} may be imported only in ${zones.join(', ')}; everything else uses @agentlink/crypto (AGENTS.md).`,
    });
  }
  return { 'no-restricted-imports': ['error', { paths, patterns }] };
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

const ZONES_WITH_EXEMPTIONS = [
  ...new Set([...NODE_ZONES, ...LIBRARIES.flatMap(({ zones }) => zones)]),
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**'] },
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
    files: [`packages/**/*.${SOURCE}`, `apps/**/*.${SOURCE}`],
    rules: restrictionsFor(null),
  },
  ...ZONES_WITH_EXEMPTIONS.map((zone) => ({
    files: [`${zone}/**/*.${SOURCE}`],
    rules: restrictionsFor(zone),
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
