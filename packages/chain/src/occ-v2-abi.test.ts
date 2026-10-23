// M1-3f (D-83, 05 §3, §6, §7): the OCC v2 contract surface this package binds to.
//
// 1. The release pin: @4thtech-io/chain binds to exactly one imported contracts release.
// 2. The ABI is the interface: every function selector, event topic and error selector of the
//    vendored ABIs equals the pinned list below. The list was computed independently (viem's
//    keccak256 over the canonical signatures) when the release was imported; this test recomputes
//    it with @4thtech-io/crypto. A new release that changes any signature fails here until the list
//    is reviewed and updated in the import PR.
// 3. The EIP-712 types in @4thtech-io/crypto match the contract structs: the `Record` and `Receipt`
//    tuples the Notary takes have the same fields, types and order, so the type hashes agree. The
//    types stay in @4thtech-io/crypto (AUDIT-FABLE-OCC19-1 L-2); this only checks them.
// 4. The addresses are the release's: the package keeps them in a scanner-safe generated form (no
//    address file is vendored), and this test rebuilds the exact addresses/<chainId>.json bytes the
//    exporter wrote (sorted keys, two-space indent, final newline) and checks their SHA-256 against
//    the vendored manifest, whose own hash is pinned. The loader applies viem's EIP-55 getAddress.
import {
  RECEIPT_TYPES,
  RECORD_TYPES,
  eip712TypeHash,
  encodeHex0x,
  encodeUtf8,
  encodeHex,
  keccak256,
  sha256,
  type TypedDataField,
} from '@4thtech-io/crypto';
import {
  DEPLOYMENT_CHAIN_IDS,
  OCC_V2_MANIFEST_FILES,
  OCC_V2_RELEASE,
  deploymentFileText,
  getDeployment,
  occErrorsAbi,
  occFeeVaultAbi,
  occFeeVaultClientAbi,
  occFeeVaultRelayAbi,
  occManagedAbi,
  occNotaryAbi,
  openZeppelinInheritedAbi,
} from '@4thtech-io/occ-v2-abi';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { OCC_V2_ABI_PIN, loadOccV2Contracts } from './index.js';

interface Param {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly Param[];
}
interface Item {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly Param[];
}

const canonical = (param: Param): string =>
  param.type.startsWith('tuple')
    ? `(${(param.components ?? []).map(canonical).join(',')})${param.type.slice(5)}`
    : param.type;

/** [type, canonical signature, selector (4 bytes) or topic (32 bytes)] for every ABI item. */
function surface(abi: readonly Item[]): (readonly [string, string, string])[] {
  return abi.map((item) => {
    const signature = `${item.name ?? ''}(${(item.inputs ?? []).map(canonical).join(',')})`;
    const hash = encodeHex0x(keccak256(encodeUtf8(signature)));
    return [item.type, signature, item.type === 'event' ? hash : hash.slice(0, 10)] as const;
  });
}

const ABIS: Record<string, readonly Item[]> = {
  IOCCErrors: occErrorsAbi,
  IOCCFeeVault: occFeeVaultAbi,
  IOCCManaged: occManagedAbi,
  IOCCNotary: occNotaryAbi,
  OpenZeppelinInherited: openZeppelinInheritedAbi,
};

const PINNED_SURFACE: Record<string, readonly (readonly [string, string, string])[]> = {
  IOCCErrors: [
    ['error', 'AppExists()', '0x4aed37ce'],
    ['error', 'AppInactive()', '0x89693c82'],
    ['error', 'BelowMinDeposit()', '0x96ec8e54'],
    ['error', 'ConflictingReceipt()', '0x949896d9'],
    ['error', 'DepositMismatch()', '0xe45a15b0'],
    ['error', 'EnforcedPause()', '0xd93c0665'],
    ['error', 'ExpectedPause()', '0x8dfc202b'],
    ['error', 'Expired()', '0x203d82d8'],
    ['error', 'FeeAboveCap()', '0x652853ee'],
    ['error', 'FeeAboveMax(uint256,uint256)', '0x7b7d1b03'],
    ['error', 'InsufficientCredits(address,address,uint256,uint256)', '0x4c6fea3e'],
    ['error', 'InvalidCapChange()', '0x8ca8b9f9'],
    ['error', 'InvalidSignature()', '0x8baa579f'],
    ['error', 'MultipleAboveMax()', '0x4828b69b'],
    ['error', 'NotIntegrator()', '0xf0048a50'],
    ['error', 'NotModule()', '0x9ba0c83a'],
    ['error', 'NotRecipient()', '0x586d3357'],
    ['error', 'NotSigner()', '0xa1b035c8'],
    ['error', 'ReceiptExists()', '0x4b707235'],
    ['error', 'RecordExists()', '0x8301f393'],
    ['error', 'RecordNotFound()', '0x3e07f1a1'],
    ['error', 'TokenNotAllowed(address)', '0x94403b70'],
    ['error', 'TransferFailed()', '0x90b8ec18'],
    ['error', 'UpgradesAreFrozen()', '0xb60e7ed8'],
    ['error', 'ZeroAddress()', '0xd92e233d'],
  ],
  IOCCFeeVault: [
    ['function', 'charge(address,uint8,bytes32,address,uint256)', '0x8e575828'],
    ['function', 'creditsOf(address,address)', '0x9235f837'],
    ['function', 'deposit(address,uint256)', '0x47e7ef24'],
    ['function', 'depositFor(address,address,uint256)', '0xb3db428b'],
    ['function', 'depositFromModule(address,address,uint256)', '0x60177886'],
    [
      'function',
      'depositWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
      '0x8a94d4fc',
    ],
    ['function', 'feeTokenAllowed(address)', '0xd9ad0218'],
    ['function', 'getApp(bytes32)', '0x42c71f1d'],
    ['function', 'integratorAccrued(bytes32,address)', '0x4968cf8e'],
    ['function', 'integratorFee(bytes32,uint8,address)', '0xe9b3d23d'],
    ['function', 'integratorFeeCapMultiple()', '0x2cdc95ac'],
    ['function', 'isModule(address)', '0x42f6e389'],
    ['function', 'lowerMaxProtocolFee(uint8,address,uint256)', '0x5c903c3a'],
    ['function', 'maxProtocolFee(uint8,address)', '0x066b6c4c'],
    ['function', 'minDeposit(address)', '0x3c29f839'],
    ['function', 'pause()', '0x8456cb59'],
    ['function', 'paused()', '0x5c975abb'],
    ['function', 'protocolAccrued(address)', '0x913f5136'],
    ['function', 'protocolFee(uint8,address)', '0x6bbc2cce'],
    ['function', 'quote(uint8,address,bytes32)', '0x01cc9947'],
    ['function', 'raiseMaxProtocolFee(uint8,address,uint256)', '0xfab275d6'],
    ['function', 'registerApp(string)', '0xb3a55f64'],
    ['function', 'registerModule(address)', '0xad64ae4b'],
    ['function', 'removeModule(address)', '0xa0632461'],
    ['function', 'setAppActive(bytes32,bool)', '0x2225ca1f'],
    ['function', 'setFeeTokenAllowed(address,bool)', '0xa8990a2f'],
    ['function', 'setIntegrator(bytes32,address)', '0x2de34c56'],
    ['function', 'setIntegratorFee(bytes32,uint8,address,uint256)', '0xd2432cc8'],
    ['function', 'setIntegratorFeeCapMultiple(uint16)', '0x671876ce'],
    ['function', 'setMinDeposit(address,uint256)', '0x912d1a86'],
    ['function', 'setProtocolFee(uint8,address,uint256)', '0x294fd4c6'],
    ['function', 'setTreasury(address)', '0xf0f44260'],
    ['function', 'sweep(address)', '0x01681a62'],
    ['function', 'treasury()', '0x61d027b3'],
    ['function', 'unpause()', '0x3f4ba83a'],
    ['function', 'upgradeToAndCall(address,bytes)', '0x4f1ef286'],
    ['function', 'withdraw(address,uint256,address)', '0x69328dec'],
    ['function', 'withdrawIntegrator(bytes32,address,address)', '0xbbf5c412'],
    [
      'event',
      'AppRegistered(bytes32,address,string)',
      '0xbea7ac15a48772a17a8be62b60631c94946c80a265e7f5b9a0c71e0736da71f1',
    ],
    [
      'event',
      'AppStatusChanged(bytes32,bool)',
      '0xefab6648e2d39e15a02c16a8fc710bc66a8cc1a9847e6bfb0fe91131c712b469',
    ],
    [
      'event',
      'CapSet(uint8,address,uint256)',
      '0x8dd110f187eef9805f7deb4ef887872c412ba50e3f793165b370b6f9ccfc8858',
    ],
    [
      'event',
      'Charged(address,uint8,bytes32,address,uint256,uint256)',
      '0xf0e2a76a4c4b2139a2f7e118580265811cf61ca81c14c4c8bb40e973e2247e70',
    ],
    [
      'event',
      'Deposited(address,address,uint256,address)',
      '0x4a82d3f4fd2c64329f08a8da5d7b66f87ecfb87e7045120c538eb1f51eb1a1d3',
    ],
    [
      'event',
      'FeeSet(uint8,address,uint256)',
      '0x7b502606b2c44fd974a63ff1d267c7f7160e930edf36f250445813b3f31f5bbc',
    ],
    [
      'event',
      'IntegratorChanged(bytes32,address,address)',
      '0xecb38c1c01b9e08107595432f72bc3684ec2c27aa99b68ae880411acafd33035',
    ],
    [
      'event',
      'IntegratorFeeCapMultipleSet(uint16)',
      '0x22646512b9d250595c50a228719817a86f86eee1c892e81f2404c37316c007fc',
    ],
    [
      'event',
      'IntegratorFeeSet(bytes32,uint8,address,uint256)',
      '0xc3f0aab98f669b80972eb55f33968ea4366c802317150c880586f016d463d976',
    ],
    [
      'event',
      'IntegratorWithdrawn(bytes32,address,address,uint256)',
      '0xcac356a908751f5b49b3ed4189913b3cf47d2c50623119a772130c6aa6432c9c',
    ],
    [
      'event',
      'MinDepositSet(address,uint256)',
      '0x10e01ab58d6a5b3e12d9a24cf08225b00864f088f38434a62aa3edc46402d286',
    ],
    [
      'event',
      'ModuleSet(address,bool)',
      '0x96bf850214e832f3d463d74cdf933b2aa73175e078496bd11f5e8afaeb2bbb9c',
    ],
    [
      'event',
      'Paused(address)',
      '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258',
    ],
    [
      'event',
      'Swept(address,uint256,address)',
      '0xbb3f74f3539ea7725781ff6810125a75c183f5c944318fc94873d1324f0482ae',
    ],
    [
      'event',
      'TokenAllowed(address,bool)',
      '0x9a8e30a8658b96ab3f034ce4bac6806278b4aee5880ccdd1ac35e4ed5bb31d23',
    ],
    [
      'event',
      'TreasuryChanged(address,address)',
      '0x8c3aa5f43a388513435861bf27dfad7829cd248696fed367c62d441f62954496',
    ],
    [
      'event',
      'Unpaused(address)',
      '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
    ],
    [
      'event',
      'Withdrawn(address,address,uint256,address)',
      '0x889d364b5102aee044ff370e2e6a836584e5618a16dce4f5b191459cf3903e58',
    ],
    ['error', 'AppExists()', '0x4aed37ce'],
    ['error', 'AppInactive()', '0x89693c82'],
    ['error', 'BelowMinDeposit()', '0x96ec8e54'],
    ['error', 'ConflictingReceipt()', '0x949896d9'],
    ['error', 'DepositMismatch()', '0xe45a15b0'],
    ['error', 'EnforcedPause()', '0xd93c0665'],
    ['error', 'ExpectedPause()', '0x8dfc202b'],
    ['error', 'Expired()', '0x203d82d8'],
    ['error', 'FeeAboveCap()', '0x652853ee'],
    ['error', 'FeeAboveMax(uint256,uint256)', '0x7b7d1b03'],
    ['error', 'InsufficientCredits(address,address,uint256,uint256)', '0x4c6fea3e'],
    ['error', 'InvalidCapChange()', '0x8ca8b9f9'],
    ['error', 'InvalidSignature()', '0x8baa579f'],
    ['error', 'MultipleAboveMax()', '0x4828b69b'],
    ['error', 'NotIntegrator()', '0xf0048a50'],
    ['error', 'NotModule()', '0x9ba0c83a'],
    ['error', 'NotRecipient()', '0x586d3357'],
    ['error', 'NotSigner()', '0xa1b035c8'],
    ['error', 'ReceiptExists()', '0x4b707235'],
    ['error', 'RecordExists()', '0x8301f393'],
    ['error', 'RecordNotFound()', '0x3e07f1a1'],
    ['error', 'TokenNotAllowed(address)', '0x94403b70'],
    ['error', 'TransferFailed()', '0x90b8ec18'],
    ['error', 'UpgradesAreFrozen()', '0xb60e7ed8'],
    ['error', 'ZeroAddress()', '0xd92e233d'],
  ],
  IOCCManaged: [
    ['function', 'pause()', '0x8456cb59'],
    ['function', 'paused()', '0x5c975abb'],
    ['function', 'unpause()', '0x3f4ba83a'],
    ['function', 'upgradeToAndCall(address,bytes)', '0x4f1ef286'],
    [
      'event',
      'Paused(address)',
      '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258',
    ],
    [
      'event',
      'Unpaused(address)',
      '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
    ],
  ],
  IOCCNotary: [
    ['function', 'acknowledge((address,bytes32,uint8,bytes32,uint64),bytes)', '0x4b27b9c3'],
    [
      'function',
      'acknowledgeBatch((address,bytes32,uint8,bytes32,uint64)[],bytes[])',
      '0xb87c66ed',
    ],
    ['function', 'computeRecordId(address,uint256)', '0xcc6ca00d'],
    ['function', 'freezeUpgrades()', '0x152d0731'],
    ['function', 'getRecord(bytes32)', '0x213681cd'],
    [
      'function',
      'notarize((address,bytes32,bytes32,bytes32,bytes32,uint8,address,uint256,uint256,uint64),bytes)',
      '0xed8539e9',
    ],
    [
      'function',
      'notarizeBatch((address,bytes32,bytes32,bytes32,bytes32,uint8,address,uint256,uint256,uint64)[],bytes[])',
      '0x026e3ca5',
    ],
    [
      'function',
      'notarizeDirect((address,bytes32,bytes32,bytes32,bytes32,uint8,address,uint256,uint256,uint64))',
      '0xc814929f',
    ],
    ['function', 'pause()', '0x8456cb59'],
    ['function', 'paused()', '0x5c975abb'],
    ['function', 'unpause()', '0x3f4ba83a'],
    ['function', 'upgradeToAndCall(address,bytes)', '0x4f1ef286'],
    ['function', 'upgradesFrozen()', '0x6d439372'],
    ['function', 'vault()', '0xfbfa77cf'],
    [
      'event',
      'Paused(address)',
      '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258',
    ],
    [
      'event',
      'ReceiptRecorded(bytes32,uint8,address,uint64)',
      '0xf86eafb1c6fadd5c67758d7378bf29afa117408744cdbb33e826912dab2e29d1',
    ],
    [
      'event',
      'ReceiptSkipped(bytes32,uint8)',
      '0x357f58fc8bd3eb1d9ee61878fe8ff02d30e6a49d25194ff2d31dce3f432021aa',
    ],
    [
      'event',
      'RecordNotarized(bytes32,address,bytes32,bytes32,bytes32,bytes32,uint8,uint64)',
      '0x96a2a8d8fd5e6089e779e86911529b2479f3f1e2f44c0a67af6c211bd11895d3',
    ],
    [
      'event',
      'RecordSkipped(bytes32)',
      '0xbafca0253929966140d1793a8425fd8c92ea0dbbbe256619da0662ed30ae7bed',
    ],
    [
      'event',
      'Unpaused(address)',
      '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
    ],
    [
      'event',
      'UpgradesFrozen()',
      '0xbbbfc8f80672f98366c78f334ec935871991b2825f67cbe69bae201705e81a0c',
    ],
    ['error', 'AppExists()', '0x4aed37ce'],
    ['error', 'AppInactive()', '0x89693c82'],
    ['error', 'BelowMinDeposit()', '0x96ec8e54'],
    ['error', 'ConflictingReceipt()', '0x949896d9'],
    ['error', 'DepositMismatch()', '0xe45a15b0'],
    ['error', 'EnforcedPause()', '0xd93c0665'],
    ['error', 'ExpectedPause()', '0x8dfc202b'],
    ['error', 'Expired()', '0x203d82d8'],
    ['error', 'FeeAboveCap()', '0x652853ee'],
    ['error', 'FeeAboveMax(uint256,uint256)', '0x7b7d1b03'],
    ['error', 'InsufficientCredits(address,address,uint256,uint256)', '0x4c6fea3e'],
    ['error', 'InvalidCapChange()', '0x8ca8b9f9'],
    ['error', 'InvalidSignature()', '0x8baa579f'],
    ['error', 'MultipleAboveMax()', '0x4828b69b'],
    ['error', 'NotIntegrator()', '0xf0048a50'],
    ['error', 'NotModule()', '0x9ba0c83a'],
    ['error', 'NotRecipient()', '0x586d3357'],
    ['error', 'NotSigner()', '0xa1b035c8'],
    ['error', 'ReceiptExists()', '0x4b707235'],
    ['error', 'RecordExists()', '0x8301f393'],
    ['error', 'RecordNotFound()', '0x3e07f1a1'],
    ['error', 'TokenNotAllowed(address)', '0x94403b70'],
    ['error', 'TransferFailed()', '0x90b8ec18'],
    ['error', 'UpgradesAreFrozen()', '0xb60e7ed8'],
    ['error', 'ZeroAddress()', '0xd92e233d'],
  ],
  OpenZeppelinInherited: [
    [
      'event',
      'AuthorityUpdated(address)',
      '0x2f658b440c35314f52658ea8a740e05b284cdc84dc9ae01e891f21b8933e7cad',
    ],
    [
      'event',
      'Initialized(uint64)',
      '0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2',
    ],
    [
      'event',
      'Upgraded(address)',
      '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
    ],
    ['error', 'AccessManagedInvalidAuthority(address)', '0xc2f31e5e'],
    ['error', 'AccessManagedRequiredDelay(address,uint32)', '0xaf77169d'],
    ['error', 'AccessManagedUnauthorized(address)', '0x068ca9d8'],
    ['error', 'AddressEmptyCode(address)', '0x9996b315'],
    ['error', 'ERC1967InvalidImplementation(address)', '0x4c9c8ce3'],
    ['error', 'ERC1967NonPayable()', '0xb398979f'],
    ['error', 'FailedCall()', '0xd6bda275'],
    ['error', 'InvalidInitialization()', '0xf92ee8a9'],
    ['error', 'NotInitializing()', '0xd7e6bcf8'],
    ['error', 'ReentrancyGuardReentrantCall()', '0x3ee5aeb5'],
    ['error', 'SafeERC20FailedOperation(address)', '0x5274afe7'],
    ['error', 'UUPSUnauthorizedCallContext()', '0xe07c8dba'],
    ['error', 'UUPSUnsupportedProxiableUUID(bytes32)', '0xaa1d49a4'],
  ],
};

/** keccak256 of the 05 §3.1 type strings, computed independently with viem at import. */
const RECORD_TYPEHASH = '0x4973ba516df14eb498782adb1b208632ae67f1a31da3b44e34b92ea623d85d32';
const RECEIPT_TYPEHASH = '0x5b6f972a463bedeae0907a01d9c2d619165bfefe57f418cc4625f984054fe042';

/** The struct tuple a Notary function takes as its first argument. */
function structOf(name: string): readonly TypedDataField[] {
  const fn = (occNotaryAbi as readonly Item[]).find(
    (item) => item.type === 'function' && item.name === name,
  );
  const components = fn?.inputs?.[0]?.components ?? [];
  return components.map(({ name: field = '', type }) => ({ name: field, type }));
}

describe('OCC v2 contract surface', () => {
  it('pins the imported contracts release exactly', () => {
    expect(OCC_V2_ABI_PIN).toEqual({
      tag: OCC_V2_RELEASE.tag,
      manifestSha256: OCC_V2_RELEASE.manifestSha256,
    });
    expect(OCC_V2_ABI_PIN).toEqual({
      tag: 'v0.1.0-testnet.4',
      manifestSha256: '4d2bfc98e71da1ed3b60fed574c0333ee945a17e701e32bfab10d6cab5bb436e',
    });
  });

  it('has exactly the pinned ABI files', () => {
    expect(Object.keys(ABIS).sort()).toEqual(Object.keys(PINNED_SURFACE).sort());
  });

  it.each(Object.keys(PINNED_SURFACE))(
    '%s: selectors, event topics and errors equal the pinned list',
    (name) => {
      expect(surface(ABIS[name] ?? [])).toEqual(PINNED_SURFACE[name]);
    },
  );

  it.each([
    ['notarize', 'tuple'],
    ['notarizeDirect', 'tuple'],
    ['notarizeBatch', 'tuple[]'],
  ])('%s takes the 05 §3.1 Record struct of @4thtech-io/crypto', (fn, type) => {
    const fields = structOf(fn);
    expect(fields).toEqual(RECORD_TYPES.Record?.map(({ name, type: t }) => ({ name, type: t })));
    const params = (occNotaryAbi as readonly Item[]).find((item) => item.name === fn)?.inputs;
    expect(params?.[0]?.type).toBe(type);
    expect(
      encodeHex0x(
        eip712TypeHash({ EIP712Domain: RECORD_TYPES.EIP712Domain ?? [], Record: fields }, 'Record'),
      ),
    ).toBe(encodeHex0x(eip712TypeHash(RECORD_TYPES, 'Record')));
  });

  it.each([
    ['acknowledge', 'tuple'],
    ['acknowledgeBatch', 'tuple[]'],
  ])('%s takes the 05 §3.1 Receipt struct of @4thtech-io/crypto', (fn, type) => {
    const fields = structOf(fn);
    expect(fields).toEqual(RECEIPT_TYPES.Receipt?.map(({ name, type: t }) => ({ name, type: t })));
    const params = (occNotaryAbi as readonly Item[]).find((item) => item.name === fn)?.inputs;
    expect(params?.[0]?.type).toBe(type);
    expect(
      encodeHex0x(
        eip712TypeHash(
          { EIP712Domain: RECEIPT_TYPES.EIP712Domain ?? [], Receipt: fields },
          'Receipt',
        ),
      ),
    ).toBe(encodeHex0x(eip712TypeHash(RECEIPT_TYPES, 'Receipt')));
  });

  it('pins the Record and Receipt type hashes', () => {
    expect(encodeHex0x(eip712TypeHash(RECORD_TYPES, 'Record'))).toBe(RECORD_TYPEHASH);
    expect(encodeHex0x(eip712TypeHash(RECEIPT_TYPES, 'Receipt'))).toBe(RECEIPT_TYPEHASH);
  });

  it('rebuilds every addresses/<chainId>.json byte for byte: its SHA-256 equals the manifest entry', () => {
    expect(Object.keys(OCC_V2_MANIFEST_FILES).filter((p) => p.startsWith('addresses/'))).toEqual([
      'addresses/10200.json',
      'addresses/84532.json',
    ]);
    for (const chainId of DEPLOYMENT_CHAIN_IDS) {
      const text = deploymentFileText(chainId) ?? '';
      expect(encodeHex(sha256(encodeUtf8(text)))).toBe(
        OCC_V2_MANIFEST_FILES[`addresses/${chainId}.json`],
      );
    }
  });

  it('pins the manifest file hashes to the release', () => {
    expect(OCC_V2_MANIFEST_FILES).toEqual(MANIFEST_FILES);
  });

  it('loads the Base Sepolia contracts through viem getAddress (EIP-55)', () => {
    const loaded = loadOccV2Contracts(84532);
    const deployment = getDeployment(84532);
    expect(loaded).toEqual({
      chainId: 84532,
      notary: deployment?.contracts.OCCNotary,
      feeVault: deployment?.contracts.OCCFeeVault,
      accessManager: deployment?.contracts.AccessManager,
      feeTokens: deployment?.feeTokens.map(({ address, decimals, eip3009, native, symbol }) => ({
        address,
        decimals,
        eip3009,
        native,
        symbol,
      })),
      // v0.1.0-testnet.4 (M3-4b-t-0): the Base Sepolia vault accepts the gasless top-up.
      depositWithAuthorization: true,
      testnet: true,
    });
    for (const value of [
      loaded?.notary,
      loaded?.feeVault,
      loaded?.accessManager,
      ...(loaded?.feeTokens ?? []).map((token) => token.address),
    ]) {
      expect(value).toBe(getAddress(String(value).toLowerCase()));
    }
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('carries the gasless top-up capability for Base Sepolia only (M3-4b-t-0)', () => {
    expect(loadOccV2Contracts(84532)?.depositWithAuthorization).toBe(true);
    expect(loadOccV2Contracts(84532)?.feeTokens.map((t) => [t.symbol, t.eip3009])).toEqual([
      ['USDC', true],
    ]);
    expect(loadOccV2Contracts(10200)?.depositWithAuthorization).toBe(false);
    expect(loadOccV2Contracts(10200)?.feeTokens.every((t) => !t.eip3009)).toBe(true);
  });

  it('binds the relay ABI to exactly depositWithAuthorization, the 05 §2.5 selector', () => {
    const fns = surface(occFeeVaultRelayAbi as readonly Item[]).filter(([t]) => t === 'function');
    expect(fns).toEqual([
      [
        'function',
        'depositWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
        '0x8a94d4fc',
      ],
    ]);
    const clientFns = surface(occFeeVaultClientAbi as readonly Item[]).map(([, sig]) => sig);
    expect(clientFns.some((sig) => sig.startsWith('depositWithAuthorization('))).toBe(false);
  });

  it('loads nothing for a chain without a deployment', () => {
    for (const id of [1, 8453, 100, 31337]) expect(loadOccV2Contracts(id)).toBeUndefined();
  });
});

/** manifest.json `files` of v0.1.0-testnet.4 (its own SHA-256 is pinned as OCC_V2_ABI_PIN). */
const MANIFEST_FILES = {
  'abi/IOCCErrors.json': '2b060bf31583d879211f86ee84d5cc1bd299555a63fe69ae5d3000a51532801f',
  'abi/IOCCFeeVault.json': 'ff1ac3ab40177d81f6b7b29d779b40bbb115d5111e1615dc84936d45271f69c9',
  'abi/IOCCManaged.json': 'caa6f1a2f84ca525d7bcc9f760963c93e9db10ed19bad952699962508f00c199',
  'abi/IOCCNotary.json': '7aeb628e7f73bbed6f2ea06c563923e4049bdd0e2b4c6461649f86fc74804fc9',
  'abi/OpenZeppelinInherited.json':
    '22a6c5b849406ce930a66118c7d33ebf3db43f8090eaa82cb28b63e7e7b3fb3b',
  'addresses/10200.json': '57915ade5f3538d0c4c21a494794ddebffe816a376ef2439e43d4d4dbb406d7a',
  'addresses/84532.json': 'e1cfb528daa5c53570e31cfba6510ec695e9c4d501246ab9ca5f6e0f5e879177',
};
