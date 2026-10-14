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
  WORKSPACE_NAMES,
  ZONES,
  allowedWorkspaceNames,
  layerMessage,
  libraryMessage,
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

function restrictionsFor(zone) {
  const nodeAllowed = NODE_ZONES.includes(zone);
  const paths = nodeAllowed
    ? ['crypto', 'node:crypto'].map((name) => ({ name, message: CRYPTO_MSG }))
    : BUILTINS.map((name) => ({ name, message: NODE_MSG }));
  const patterns = nodeAllowed ? [] : [{ group: ['node:*'], message: NODE_MSG }];
  for (const lib of LIBRARIES) {
    if (zone !== null && lib.zones.includes(zone)) continue;
    patterns.push({ group: lib.group, message: libraryMessage(lib) });
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
    // Directories the policy does not know get the strictest set until they get an entry.
    files: [`packages/**/*.${SOURCE}`, `apps/**/*.${SOURCE}`],
    plugins: { boundaries },
    rules: restrictionsFor(null),
  },
  ...Object.keys(ZONES).map((zone) => ({
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
