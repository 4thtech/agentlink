import { builtinModules } from 'node:module';
import root from '../eslint.config.mjs';

// The repository config, plus one zone for the harness: it runs in Node, browsers and workerd, so no
// Node built-ins, and suites reach crypto only through @agentlink/crypto (AGENTS.md, 04 §8.1). The
// placeholder suite's direct crypto.subtle call is a global, not an import (see its header).
const NODE = 'The vector harness also runs in browsers and workerd: no Node built-ins.';
const CRYPTO = 'Vector suites test @agentlink/crypto; they never import crypto libraries directly.';

export default [
  ...root,
  {
    files: ['harness/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
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
        },
      ],
    },
  },
];
