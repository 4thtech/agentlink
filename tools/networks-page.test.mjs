// Drift check: the networks and contracts page lists exactly the addresses the private
// @4thtech-io/occ-v2-abi package carries (its src/addresses.generated.ts), and nothing else.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = join(root, 'docs-site/technical/reference/networks-and-contracts.md');
const generated = readFileSync(
  join(root, 'packages/occ-v2-abi/src/addresses.generated.ts'),
  'utf8',
);

const records = [...generated.matchAll(/'(\d+)': \{([\s\S]*?)\n {2}\},/g)].map((m) => ({
  chainId: m[1],
  body: m[2],
}));
const field = (body, key) => new RegExp(`\\b${key}: '([^']*)'`).exec(body)?.[1];
const packageAddresses = records.flatMap(({ body }) =>
  [...body.matchAll(/\b(?:notary|vault|manager|hex): '([0-9a-fA-F]{40})'/g)].map(
    (m) => `0x${m[1]}`,
  ),
);

describe('networks-and-contracts page', () => {
  it('exists', () => {
    expect(existsSync(pagePath)).toBe(true);
  });

  const page = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '';
  const pageAddresses = [...new Set(page.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])];

  it('reads at least one deployment from the package', () => {
    expect(records.length).toBeGreaterThan(0);
    expect(packageAddresses.length).toBeGreaterThanOrEqual(4);
  });

  it('lists every package address, byte for byte', () => {
    for (const address of packageAddresses) expect(pageAddresses).toContain(address);
  });

  it('lists no address the package does not carry', () => {
    for (const address of pageAddresses) expect(packageAddresses).toContain(address);
  });

  it('shows each deployment chain ID, date and block', () => {
    for (const { chainId, body } of records) {
      expect(page).toContain(chainId);
      expect(page).toContain(field(body, 'deployedOn'));
      expect(page).toContain(/deployBlock: (\d+)/.exec(body)[1]);
    }
  });

  it('links each address to its block explorer, and claims no mainnet or Chiado deployment', () => {
    expect(page).toMatch(/sepolia\.basescan\.org\/address\/0x/);
    expect(page).toMatch(/Gnosis Chiado[^\n]*planned/);
    expect(page).toMatch(/not deployed/i);
    expect(page).not.toMatch(/gnosis-chiado\.blockscout\.com\/address\/0x/);
  });
});
