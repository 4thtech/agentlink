// M1-11b-2: the app's approvals use the same words as the server-rendered approval page
// (packages/node/src/approval-page.ts UI_STRINGS), which stays for a CLI without the app bundle
// until its removal card. That package does not depend on this one, so this test reads its source:
// every key here must be there with the same text (`${CLI_COMMAND}` stands for the CLI prefix).
import { describe, expect, it } from 'vitest';
import { APPROVAL_STRINGS, CLI_PREFIX } from './strings.js';

// Read through Vite: a relative import would leave the app (boundaries rule).
const files = import.meta.glob(
  ['../../../../../packages/node/src/approval-page.ts', '../../../../../packages/node/src/cli-command.ts'],
  { query: '?raw', import: 'default', eager: true },
);

function source(name: string): string {
  const entry = Object.entries(files).find(([path]) => path.endsWith(name));
  const text = entry?.[1];
  if (typeof text !== 'string' || text === '') throw new Error(`${name} missing`);
  return text;
}

describe('the approvals words match the approval page (M1-11b-2)', () => {
  it('uses the same CLI prefix', () => {
    expect(source('cli-command.ts')).toContain(`export const CLI_COMMAND = '${CLI_PREFIX}';`);
  });

  it.each(Object.entries(APPROVAL_STRINGS))('%s', (key, value) => {
    const page = source('approval-page.ts');
    const start = page.indexOf(`\n  ${key}:`);
    expect(start, `UI_STRINGS.${key} missing`).toBeGreaterThan(0);
    const rest = page.slice(start + key.length + 4);
    const end = rest.search(/\n {2}(?:\/\/|[a-zA-Z]+:)|\n\}\);/);
    const entry = rest.slice(0, end < 0 ? undefined : end);
    const templated = value.split(CLI_PREFIX).join('${CLI_COMMAND}');
    const forms = [`'${value}'`, `"${value}"`, `\`${templated}\``];
    expect(
      forms.some((f) => entry.includes(f)),
      `UI_STRINGS.${key} differs`,
    ).toBe(true);
  });
});
