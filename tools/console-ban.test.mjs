// Lint fixture test for the console ban (M0-8, IR-M0-8-1 F11). Flat config replaces rule options,
// so a later zone block that sets no-restricted-syntax could silently drop the console selectors.
// This lints probe code at a virtual path in every package and app (source and test files) and
// asserts each route to the console or the process output streams is still flagged, and that the
// documented channels are not.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let eslint;
// The first lintText loads the config, the TypeScript parser and the plugins, which can take more
// than a test's timeout on a cold CI runner (M0-10d). Warm up here, under an explicit hook timeout,
// so every test measures only a warm lint.
beforeAll(async () => {
  eslint = new ESLint({ cwd: root });
  await eslint.lintText('export {};\n', { filePath: join(root, 'packages/core/src/warmup.ts') });
}, 60_000);

const zones = ['packages', 'apps'].flatMap((top) =>
  readdirSync(join(root, top), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${top}/${entry.name}`),
);

const PROBES = {
  'globalThis.console': `export const f = (): void => (globalThis as unknown as { console: { log(x: string): void } }).console.log('x');`,
  'declare const console': `declare const console: { log(x: string): void };\nexport const f = (): void => console.log('x');`,
  'process.stdout.write': `declare const process: { stdout: { write(x: string): void } };\nexport const f = (): void => process.stdout.write('x');`,
};

async function rulesHit(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.map((message) => message.ruleId);
}

describe('console ban in every zone', () => {
  it('found the zones', () => {
    expect(zones).toContain('packages/log');
    expect(zones).toContain('apps/cli');
  });

  for (const zone of zones) {
    for (const [name, code] of Object.entries(PROBES)) {
      for (const file of ['src/m08-probe.ts', 'src/m08-probe.test.ts']) {
        it(`${zone}/${file}: ${name} is flagged`, async () => {
          expect(await rulesHit(code, `${zone}/${file}`)).toContain('no-restricted-syntax');
        });
      }
    }
  }

  it.each([
    'packages/log/src/console.ts',
    'apps/cli/src/output.ts',
    'packages/node/src/owner-terminal.ts',
  ])('the documented channel %s is not flagged', async (file) => {
    expect(await rulesHit(PROBES['globalThis.console'], file)).not.toContain(
      'no-restricted-syntax',
    );
  });
});
