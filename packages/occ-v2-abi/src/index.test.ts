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

  it('has addresses for Base Sepolia (84532) only, marked testnet', () => {
    expect(DEPLOYMENT_CHAIN_IDS).toEqual([84532]);
    expect(Object.keys(deployments)).toEqual(['84532']);
    const base = getDeployment(84532);
    expect(base).toMatchObject({
      chainId: 84532,
      chainKey: 'base-sepolia',
      testnet: true,
      contracts: {
        OCCNotary: '0xB29dEdEe26D480105DAD5b90f549a09d376d855F',
        OCCFeeVault: '0x91A40104553Bd1731c3fBe05209A908B40e50f8d',
        AccessManager: '0x7B05B6C56E4f073df60da9Fa640b1f7ffCD9D3A2',
      },
    });
    expect(base?.feeTokens).toEqual([
      {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        eip3009: false,
        native: false,
        symbol: 'USDC',
      },
    ]);
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
