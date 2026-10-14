import { builtinModules } from 'node:module';
import root from '../eslint.config.mjs';

// The repository config, plus zones for the harness: it runs in Node, browsers and workerd, so no
// Node built-ins, and suites reach crypto only through @agentlink/crypto (AGENTS.md, 04 §8.1). The
// placeholder suite's direct crypto.subtle call is a global, not an import; M0-10 exempts exactly
// test-vectors/**/placeholder-sha256.ts. ESLint applies only the last matching
// no-restricted-imports block, so the suites block repeats the harness list.
const NODE = 'The vector harness also runs in browsers and workerd: no Node built-ins.';
const CRYPTO = 'Vector suites test @agentlink/crypto; they never import crypto libraries directly.';
const EXPECTED =
  'Suite modules never read vectors: they get id and input, and compare.ts checks expected values.';

const harness = {
  paths: builtinModules
    .filter((name) => !name.startsWith('node:'))
    .map((name) => ({ name, message: NODE })),
  patterns: [
    { group: ['node:*'], message: NODE },
    {
      group: ['@noble/*', '@hpke/*', 'nostr-tools', 'nostr-tools/*', 'viem', 'viem/*'],
      message: CRYPTO,
    },
    { group: ['aws4fetch'], message: CRYPTO },
  ],
};

export default [
  ...root,
  {
    files: ['harness/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', harness] },
  },
  {
    // IR-M0-9-1 F03: a suite must not be able to copy the expected values it is judged against.
    files: ['harness/suites/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: harness.paths,
          patterns: [
            ...harness.patterns,
            { group: ['**/*.json', '**/*.json?*'], message: EXPECTED },
            {
              group: ['**/registry', '**/registry.*', '**/compare', '**/compare.*'],
              message: EXPECTED,
            },
          ],
        },
      ],
    },
  },
];
