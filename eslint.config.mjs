import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // No Node built-ins outside @agentlink/node and apps/cli (docs/process/repo-reference.md).
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    ignores: ['packages/node/**', 'apps/cli/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'Node built-ins are allowed only in @agentlink/node and apps/cli.',
            },
          ],
        },
      ],
    },
  },
  {
    // Shared packages must run in Node, browsers and Workers, so they get no Node globals.
    // Node-only code gets them: build tooling, config files and tests (which run in Node).
    files: ['tools/**', '**/*.test.ts', '**/*.config.{ts,mjs}', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
