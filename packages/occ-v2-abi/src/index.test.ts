// M1-3f (D-83; AUDIT-FABLE-OCC19-1 M-1, L-1): the client-safe ABI subset and the address bundle.
// The exported interfaces carry admin, upgrade and module-only functions untagged; this package tags
// every function and the client ABIs hold only the `client` ones, so tool code cannot call an admin
// function by accident. Gated on chain anyway (05 §5); this is defence in depth, not a boundary.
import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_CHAIN_IDS,
  FEE_VAULT_FUNCTION_TAGS,
  FUNCTION_TAGS,
  NOTARY_FUNCTION_TAGS,
  OCC_V2_RELEASE,
  deploymentFileText,
  deployments,
  getDeployment,
  occErrorsAbi,
  occFeeVaultAbi,
  occFeeVaultClientAbi,
  occManagedAbi,
  occNotaryAbi,
  occNotaryClientAbi,
  openZeppelinInheritedAbi,
  packageName,
} from './index.js';

type Item = { readonly type: string; readonly name?: string };
const functionNames = (abi: readonly Item[]) =>
  abi.filter((item) => item.type === 'function').map((item) => item.name ?? '');
const namesOf = (abi: readonly Item[], type: string) =>
  abi
    .filter((item) => item.type === type)
    .map((item) => item.name ?? '')
    .sort();

/** Functions no client may call: governance, upgrades, the vault's module path, maintenance. */
const NEVER_CLIENT = [
  'pause',
  'unpause',
  'upgradeToAndCall',
  'freezeUpgrades',
  'setProtocolFee',
  'raiseMaxProtocolFee',
  'lowerMaxProtocolFee',
  'setIntegratorFeeCapMultiple',
  'setAppActive',
  'setFeeTokenAllowed',
  'setMinDeposit',
  'setTreasury',
  'registerModule',
  'removeModule',
  'charge',
  'depositFromModule',
  'sweep',
];

describe('@4thtech-io/occ-v2-abi', () => {
  it('exports its package name and the release it was imported from', () => {
    expect(packageName).toBe('@4thtech-io/occ-v2-abi');
    expect(OCC_V2_RELEASE).toEqual({
      repository: '4thtech/occ-v2-contracts',
      tag: 'v0.1.0-testnet.2',
      sourceCommit: 'd46545b60bb324f63fb16a77af445bd50a51317a',
      manifestSha256: 'b1a8daa57d51bcbfbecbc91e6c5d2740d76428a4f63bbd5f1043537591188c1b',
      compiler: '0.8.37+commit.f401782d',
    });
  });

  it('tags every function of the Notary and the vault exactly once', () => {
    expect(Object.keys(NOTARY_FUNCTION_TAGS).sort()).toEqual(
      [...new Set(functionNames(occNotaryAbi))].sort(),
    );
    expect(Object.keys(FEE_VAULT_FUNCTION_TAGS).sort()).toEqual(
      [...new Set(functionNames(occFeeVaultAbi))].sort(),
    );
    expect(FUNCTION_TAGS).toEqual({
      OCCNotary: NOTARY_FUNCTION_TAGS,
      OCCFeeVault: FEE_VAULT_FUNCTION_TAGS,
    });
  });

  it('keeps admin, upgrade, module and maintenance functions out of the client ABIs', () => {
    for (const abi of [occNotaryClientAbi, occFeeVaultClientAbi]) {
      const names = functionNames(abi);
      for (const name of NEVER_CLIENT) expect(names).not.toContain(name);
    }
    for (const tags of [NOTARY_FUNCTION_TAGS, FEE_VAULT_FUNCTION_TAGS]) {
      for (const [name, tag] of Object.entries(tags)) {
        if (NEVER_CLIENT.includes(name)) expect(tag).not.toBe('client');
      }
    }
  });

  it('holds exactly the client-tagged functions, in ABI order', () => {
    const clientOf = (tags: Record<string, string>) =>
      Object.entries(tags)
        .filter(([, tag]) => tag === 'client')
        .map(([name]) => name);
    expect(functionNames(occNotaryClientAbi)).toEqual(
      functionNames(occNotaryAbi).filter((name) => clientOf(NOTARY_FUNCTION_TAGS).includes(name)),
    );
    expect(functionNames(occFeeVaultClientAbi)).toEqual(
      functionNames(occFeeVaultAbi).filter((name) =>
        clientOf(FEE_VAULT_FUNCTION_TAGS).includes(name),
      ),
    );
    expect(functionNames(occNotaryClientAbi)).toEqual(
      expect.arrayContaining(['notarize', 'notarizeBatch', 'acknowledge', 'getRecord']),
    );
    expect(functionNames(occFeeVaultClientAbi)).toEqual(
      expect.arrayContaining(['deposit', 'depositFor', 'withdraw', 'creditsOf', 'quote']),
    );
  });

  it('keeps depositWithAuthorization out of the client ABI while no chain enables it (M1-3c)', () => {
    expect(FEE_VAULT_FUNCTION_TAGS.depositWithAuthorization).toBe('pending');
    expect(functionNames(occFeeVaultClientAbi)).not.toContain('depositWithAuthorization');
    for (const chainId of DEPLOYMENT_CHAIN_IDS) {
      const deployment = getDeployment(chainId);
      expect(deployment?.capabilities.depositWithAuthorization).toBe(false);
      for (const token of deployment?.feeTokens ?? []) expect(token.eip3009).toBe(false);
    }
  });

  it('keeps every event and error, including the inherited OpenZeppelin ones, for decoding', () => {
    for (const [client, full] of [
      [occNotaryClientAbi, occNotaryAbi],
      [occFeeVaultClientAbi, occFeeVaultAbi],
    ] as const) {
      for (const type of ['event', 'error']) {
        expect(namesOf(client, type)).toEqual(
          [...new Set([...namesOf(full, type), ...namesOf(openZeppelinInheritedAbi, type)])].sort(),
        );
      }
    }
    expect(namesOf(occErrorsAbi, 'error')).toEqual(namesOf(occNotaryAbi, 'error'));
    expect(namesOf(occManagedAbi, 'function')).toEqual([
      'pause',
      'paused',
      'unpause',
      'upgradeToAndCall',
    ]);
  });

  it('carries the G-4 skip events (05 §6)', () => {
    expect(namesOf(occNotaryClientAbi, 'event')).toEqual(
      expect.arrayContaining(['RecordSkipped', 'ReceiptSkipped']),
    );
  });

  // The addresses themselves are checked by hash, not spelled out here: the chain test rebuilds the
  // release's addresses/84532.json bytes from them and compares the manifest's SHA-256, so no
  // address literal is needed in a test (the secret scan must stay clean, without allowlists).
  it('has a deployment for Base Sepolia (84532) only, marked testnet', () => {
    expect(DEPLOYMENT_CHAIN_IDS).toEqual([84532]);
    expect(Object.keys(deployments)).toEqual(['84532']);
    const base = getDeployment(84532);
    expect(base).toMatchObject({
      chainId: 84532,
      chainKey: 'base-sepolia',
      name: 'Base Sepolia',
      testnet: true,
      schemaVersion: 1,
      capabilities: { depositWithAuthorization: false },
    });
    const evm = /^0x[0-9a-fA-F]{40}$/;
    expect(Object.keys(base?.contracts ?? {}).sort()).toEqual([
      'AccessManager',
      'OCCFeeVault',
      'OCCNotary',
    ]);
    for (const value of Object.values(base?.contracts ?? {})) expect(value).toMatch(evm);
    expect(new Set(Object.values(base?.contracts ?? {})).size).toBe(3);
    expect(base?.feeTokens).toHaveLength(1);
    expect(base?.feeTokens[0]).toMatchObject({
      decimals: 6,
      eip3009: false,
      native: false,
      symbol: 'USDC',
    });
    expect(base?.feeTokens[0]?.address).toMatch(evm);
  });

  it('renders the deployment as the exporter writes it: sorted keys, two-space indent, final newline', () => {
    const text = deploymentFileText(84532) ?? '';
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(getDeployment(84532));
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
            )
          : value;
    expect(text).toBe(`${JSON.stringify(sorted(JSON.parse(text)), null, 2)}\n`);
    expect(text.split('\n')[1]).toBe('  "campaign": "campaign-1",');
    expect(deploymentFileText(1)).toBeUndefined();
  });

  it('returns no deployment for any other chain ID', () => {
    for (const id of [1, 8453, 100, 10200, 31337, 0, -1, 84532.5]) {
      expect(getDeployment(id)).toBeUndefined();
    }
  });

  it('freezes what it exports', () => {
    expect(Object.isFrozen(deployments)).toBe(true);
    expect(Object.isFrozen(getDeployment(84532))).toBe(true);
    expect(Object.isFrozen(occNotaryClientAbi)).toBe(true);
    expect(Object.isFrozen(NOTARY_FUNCTION_TAGS)).toBe(true);
  });
});
