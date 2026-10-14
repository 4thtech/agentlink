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

const ZONES_WITH_EXEMPTIONS = [
  ...new Set([...NODE_ZONES, ...LIBRARIES.flatMap(({ zones }) => zones)]),
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Never log secrets (AGENTS.md): no stray console output. Use the redacting logger.
    // TODO(M0-8): apps/cli needs a narrow exception for deliberate user-facing output (for example
    // `--version`), added together with the redacting logger.
    rules: { 'no-console': 'error' },
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
    files: ['tools/**'],
    rules: { 'no-console': 'off' },
  },
);
