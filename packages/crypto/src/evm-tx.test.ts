// M1-4c-b: the direct-mode transaction signer (07 §6.2; 04 §2.1, §8.1). viem is the differential
// oracle: every transaction we sign parses to exactly the fields we were given and recovers to the
// agent's EVM address, and the bytes equal viem's own signing with the same key (RFC 6979).
import {
  encodeFunctionData,
  erc20Abi,
  keccak256 as viemKeccak,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  toFunctionSelector,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { encodeHex0x } from './encoding.js';
import {
  DIRECT_TX_ALLOWLIST,
  DIRECT_TX_SELECTORS,
  KEY_LABELS,
  MAX_TX_DATA_BYTES,
  MAX_TX_VALUE_WEI,
  TRANSACTION_REFUSED,
  directTransactionDigest,
  directTransactionSnapshot,
  type DirectTransaction,
  type TransactionRefusal,
} from './index.js';
import { deriveAgentId, deriveSecretKey, signDirectTransaction } from './keystore.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const KEY = deriveSecretKey(SEED, KEY_LABELS.evm, 0);
const OWN = deriveAgentId(SEED);
const ACCOUNT = privateKeyToAccount(encodeHex0x(KEY) as `0x${string}`);
const OTHER = '0x1111111111111111111111111111111111111111';

const CHIADO = 10200;
const BASE_SEPOLIA = 84532;
const chiado = DIRECT_TX_ALLOWLIST[CHIADO]!;
const baseSepolia = DIRECT_TX_ALLOWLIST[BASE_SEPOLIA]!;
const USDC = baseSepolia.feeTokens[0]!;
const ZERO = `0x${'0'.repeat(40)}` as const;

const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address token, uint256 amount, address to)',
  'function depositFor(address payer, address token, uint256 amount) payable',
]);
const NOTARY_ABI = parseAbi([
  'struct Record { address signer; bytes32 envelopeHash; bytes32 recipientCommitment; bytes32 parentRecordId; bytes32 appId; uint8 kind; address feeToken; uint256 maxFee; uint256 nonce; uint64 deadline; }',
  'struct Receipt { address signer; bytes32 recordId; uint8 receiptType; bytes32 salt; uint64 deadline; }',
  'function notarizeDirect(Record r) payable returns (bytes32)',
  'function notarizeBatch(Record[] rs, bytes[] sigs) returns (bytes32[])',
  'function acknowledge(Receipt rc, bytes sig)',
  'function acknowledgeBatch(Receipt[] rcs, bytes[] sigs)',
  'function notarize(Record r, bytes sig) returns (bytes32)',
]);
const H32 = `0x${'ab'.repeat(32)}` as const;
const RECORD = {
  signer: OWN as `0x${string}`,
  envelopeHash: H32,
  recipientCommitment: H32,
  parentRecordId: H32,
  appId: H32,
  kind: 1,
  feeToken: ZERO,
  maxFee: 10n ** 15n,
  nonce: 7n,
  deadline: 1_800_000_000n,
} as const;
const RECEIPT = {
  signer: OWN as `0x${string}`,
  recordId: H32,
  receiptType: 1,
  salt: H32,
  deadline: 1_800_000_000n,
} as const;
const SIG = `0x${'cd'.repeat(65)}` as const;

const lower = (hex: string): string => hex.toLowerCase();
const depositData = (token: string, amount: bigint) =>
  encodeFunctionData({
    abi: VAULT_ABI,
    functionName: 'deposit',
    args: [token as `0x${string}`, amount],
  });
const withdrawData = (to: string) =>
  encodeFunctionData({
    abi: VAULT_ABI,
    functionName: 'withdraw',
    args: [ZERO, 5n, to as `0x${string}`],
  });
const approveData = (spender: string, amount = 1_000n) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as never, amount] });

/** The same transaction in viem's form. */
const viemTx = (t: DirectTransaction) =>
  ({
    type: 'eip1559',
    chainId: t.chainId,
    nonce: t.nonce,
    gas: t.gas,
    maxFeePerGas: t.maxFeePerGas,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas,
    to: t.to as `0x${string}`,
    data: t.data as `0x${string}`,
    value: t.value,
  }) as const;

function tx(over: Partial<Record<keyof DirectTransaction, unknown>> = {}): DirectTransaction {
  return {
    type: 'eip1559',
    chainId: CHIADO,
    nonce: 3,
    gas: 120_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    to: chiado.vault,
    data: depositData(ZERO, 10n ** 17n),
    value: 10n ** 17n,
    ...over,
  } as DirectTransaction;
}

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe('transaction_refused');
    return (error as Error).message;
  }
  return undefined;
}

const expectRefused = (t: unknown, reason: TransactionRefusal, own: string = OWN) =>
  expect(refusal(() => directTransactionSnapshot(t, own))).toBe(TRANSACTION_REFUSED[reason]);

/** Every allowed call, by name. */
function allowedCalls(): [string, DirectTransaction][] {
  return [
    ['native deposit on Chiado', tx()],
    [
      'notarizeDirect paying the native fee',
      tx({
        to: chiado.notary,
        value: RECORD.maxFee,
        data: encodeFunctionData({
          abi: NOTARY_ABI,
          functionName: 'notarizeDirect',
          args: [RECORD],
        }),
      }),
    ],
    [
      'notarizeBatch',
      tx({
        to: chiado.notary,
        value: 0n,
        data: encodeFunctionData({
          abi: NOTARY_ABI,
          functionName: 'notarizeBatch',
          args: [[RECORD], [SIG]],
        }),
      }),
    ],
    [
      'acknowledge',
      tx({
        to: chiado.notary,
        value: 0n,
        data: encodeFunctionData({
          abi: NOTARY_ABI,
          functionName: 'acknowledge',
          args: [RECEIPT, SIG],
        }),
      }),
    ],
    [
      'acknowledgeBatch',
      tx({
        to: chiado.notary,
        value: 0n,
        data: encodeFunctionData({
          abi: NOTARY_ABI,
          functionName: 'acknowledgeBatch',
          args: [[RECEIPT], [SIG]],
        }),
      }),
    ],
    ['withdraw to the own account', tx({ value: 0n, data: withdrawData(OWN) })],
    [
      'approve of the vault on Base Sepolia',
      tx({ chainId: BASE_SEPOLIA, to: USDC, value: 0n, data: approveData(baseSepolia.vault) }),
    ],
    [
      'a USDC deposit on Base Sepolia',
      tx({
        chainId: BASE_SEPOLIA,
        to: baseSepolia.vault,
        value: 0n,
        data: depositData(USDC, 1_000_000n),
      }),
    ],
  ];
}

describe('signDirectTransaction (M1-4c-b): viem as the oracle', () => {
  it('the selectors are the ABI functions direct mode sends', () => {
    const want: Record<string, string> = {
      notarizeDirect: toFunctionSelector(NOTARY_ABI.find((f) => f.name === 'notarizeDirect')!),
      notarizeBatch: toFunctionSelector(NOTARY_ABI.find((f) => f.name === 'notarizeBatch')!),
      acknowledge: toFunctionSelector(NOTARY_ABI.find((f) => f.name === 'acknowledge')!),
      acknowledgeBatch: toFunctionSelector(NOTARY_ABI.find((f) => f.name === 'acknowledgeBatch')!),
      deposit: toFunctionSelector(VAULT_ABI[0]),
      withdraw: toFunctionSelector(VAULT_ABI[1]),
      approve: toFunctionSelector('function approve(address,uint256)'),
    };
    expect({ ...DIRECT_TX_SELECTORS }).toEqual(want);
  });

  it.each(allowedCalls())(
    '%s: parses to the same fields, recovers to the agent and equals viem',
    async (_name, t) => {
      const raw = signDirectTransaction(KEY, t, OWN);
      expect(raw).toMatch(/^0x02[0-9a-f]+$/);
      const got = parseTransaction(raw as `0x${string}`);
      expect(got.type).toBe('eip1559');
      expect(got.chainId).toBe(t.chainId);
      expect(got.nonce).toBe(t.nonce);
      expect(got.gas).toBe(t.gas);
      expect(got.maxFeePerGas).toBe(t.maxFeePerGas);
      expect(got.maxPriorityFeePerGas).toBe(t.maxPriorityFeePerGas);
      expect(lower(got.to ?? '')).toBe(t.to);
      expect(lower(got.data ?? '0x')).toBe(t.data);
      expect(got.value ?? 0n).toBe(t.value);
      expect(got.accessList ?? []).toEqual([]);
      const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
      expect(lower(signer)).toBe(OWN);
      const theirs = await ACCOUNT.signTransaction(viemTx(t));
      expect(raw).toBe(theirs);
      // The digest is viem's over the unsigned serialisation.
      expect(encodeHex0x(directTransactionDigest(directTransactionSnapshot(t, OWN)))).toBe(
        viemKeccak(serializeTransaction(viemTx(t))),
      );
    },
  );

  it('long values: a nonce, gas and fee near their bounds still round-trip', async () => {
    const t = tx({
      nonce: Number.MAX_SAFE_INTEGER,
      gas: 15_000_000n,
      maxFeePerGas: 10_000_000_000_000n,
      maxPriorityFeePerGas: 0n,
      value: MAX_TX_VALUE_WEI,
      data: depositData(ZERO, MAX_TX_VALUE_WEI),
    });
    const raw = signDirectTransaction(KEY, t, OWN);
    expect(raw).toBe(
      await ACCOUNT.signTransaction({
        ...t,
        to: t.to as `0x${string}`,
        data: t.data as `0x${string}`,
      }),
    );
  });

  it('a large notarizeBatch (long RLP lengths) round-trips', async () => {
    const t = tx({
      to: chiado.notary,
      value: 0n,
      data: encodeFunctionData({
        abi: NOTARY_ABI,
        functionName: 'notarizeBatch',
        args: [Array(40).fill(RECORD), Array(40).fill(SIG)],
      }),
    });
    const raw = signDirectTransaction(KEY, t, OWN);
    expect(lower(await recoverTransactionAddress({ serializedTransaction: raw as never }))).toBe(
      OWN,
    );
    expect(raw).toBe(
      await ACCOUNT.signTransaction({
        ...t,
        to: t.to as `0x${string}`,
        data: t.data as `0x${string}`,
      }),
    );
  });

  it('the signer re-checks the rules: a refused transaction is refused with a key too', () => {
    expect(refusal(() => signDirectTransaction(KEY, tx({ chainId: 1 }), OWN))).toBe(
      TRANSACTION_REFUSED.chain_not_allowed,
    );
  });
});

describe('directTransactionSnapshot (M1-4c-b): the fixed refusals', () => {
  it('returns a frozen plain copy of an allowed transaction', () => {
    const t = tx();
    const snap = directTransactionSnapshot(t, OWN);
    expect(snap).toEqual(t);
    expect(snap).not.toBe(t);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('wrong chain: mainnets and unknown chains', () => {
    for (const chainId of [1, 100, 8453, 42161, 10, 137, 11155111, 31337]) {
      expectRefused(tx({ chainId }), 'chain_not_allowed');
    }
  });

  it('no mainnet is in the allowlist', () => {
    expect(Object.keys(DIRECT_TX_ALLOWLIST).map(Number).sort()).toEqual([10200, 84532]);
  });

  it('a destination outside the AgentLink contracts of that chain', () => {
    expectRefused(tx({ to: OTHER }), 'destination_not_allowed');
    // USDC is a fee token on Base Sepolia, not on Chiado.
    expectRefused(
      tx({ to: USDC, value: 0n, data: approveData(chiado.vault) }),
      'destination_not_allowed',
    );
  });

  it('contract creation', () => {
    for (const to of [undefined, null, '', '0x']) expectRefused(tx({ to }), 'contract_creation');
  });

  it('only EIP-1559', () => {
    for (const type of ['legacy', 'eip2930', 'eip4844', 'eip7702', undefined]) {
      expectRefused(tx({ type }), 'not_eip1559');
    }
  });

  it('oversized data', () => {
    const big = `${depositData(ZERO, 1n)}${'00'.repeat(MAX_TX_DATA_BYTES)}`;
    expectRefused(tx({ data: big }), 'data_too_large');
  });

  it('calls direct mode does not send', () => {
    const notary = (data: string) => tx({ to: chiado.notary, value: 0n, data });
    expectRefused(
      notary(
        encodeFunctionData({ abi: NOTARY_ABI, functionName: 'notarize', args: [RECORD, SIG] }),
      ),
      'call_not_allowed',
    );
    expectRefused(notary('0x'), 'call_not_allowed');
    expectRefused(notary('0x4b27b9'), 'call_not_allowed');
    expectRefused(
      tx({
        value: 0n,
        data: encodeFunctionData({
          abi: VAULT_ABI,
          functionName: 'depositFor',
          args: [OTHER, ZERO, 1n],
        }),
      }),
      'call_not_allowed',
    );
    // withdraw to anyone but the agent itself.
    expectRefused(tx({ value: 0n, data: withdrawData(OTHER) }), 'call_not_allowed');
    // approve of another spender, or a transfer on the fee token.
    const onUsdc = (data: string) => tx({ chainId: BASE_SEPOLIA, to: USDC, value: 0n, data });
    expectRefused(onUsdc(approveData(OTHER)), 'call_not_allowed');
    expectRefused(
      onUsdc(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [OTHER, 1n] })),
      'call_not_allowed',
    );
    // A deposit with trailing or missing words, or a dirty address word.
    expectRefused(tx({ data: `${depositData(ZERO, 1n)}00` }), 'call_not_allowed');
    expectRefused(
      tx({ value: 0n, data: `${depositData(USDC, 1n)}${'00'.repeat(32)}` }),
      'call_not_allowed',
    );
    expectRefused(tx({ data: depositData(ZERO, 1n).slice(0, -64) }), 'call_not_allowed');
    const dirty = `0x47e7ef24${'f'.repeat(24)}${'0'.repeat(40)}${'0'.repeat(63)}1`;
    expectRefused(tx({ value: 1n, data: dirty }), 'call_not_allowed');
  });

  it('value only where the call takes it, and bounded', () => {
    expectRefused(tx({ value: 1n }), 'value_not_allowed');
    expectRefused(tx({ value: 0n }), 'value_not_allowed');
    expectRefused(
      tx({ chainId: BASE_SEPOLIA, to: baseSepolia.vault, data: depositData(USDC, 5n), value: 5n }),
      'value_not_allowed',
    );
    expectRefused(tx({ data: withdrawData(OWN), value: 1n }), 'value_not_allowed');
    expectRefused(
      tx({
        to: chiado.notary,
        value: 1n,
        data: encodeFunctionData({
          abi: NOTARY_ABI,
          functionName: 'acknowledge',
          args: [RECEIPT, SIG],
        }),
      }),
      'value_not_allowed',
    );
    expectRefused(
      tx({ value: MAX_TX_VALUE_WEI + 1n, data: depositData(ZERO, MAX_TX_VALUE_WEI + 1n) }),
      'value_not_allowed',
    );
    expectRefused(tx({ value: -1n }), 'value_not_allowed');
  });

  it('gas and fee bounds', () => {
    expectRefused(tx({ gas: 20_999n }), 'fee_out_of_bounds');
    expectRefused(tx({ gas: 15_000_001n }), 'fee_out_of_bounds');
    expectRefused(tx({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }), 'fee_out_of_bounds');
    expectRefused(tx({ maxFeePerGas: 10_000_000_000_001n }), 'fee_out_of_bounds');
    expectRefused(tx({ maxPriorityFeePerGas: 2_000_000_001n }), 'fee_out_of_bounds');
    expectRefused(tx({ gas: 120_000 }), 'fee_out_of_bounds');
  });

  it('malformed shapes', () => {
    const base = tx();
    for (const bad of [
      null,
      undefined,
      'tx',
      [],
      { ...base, accessList: [] },
      { ...base, from: OWN },
      Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'nonce')),
      Object.assign(Object.create({ evil: 1 }) as object, base),
      tx({ nonce: -1 }),
      tx({ nonce: 1.5 }),
      tx({ nonce: 3n }),
      tx({ chainId: '10200' }),
      tx({ chainId: 10200n }),
      tx({ to: chiado.vault.toUpperCase().replace('0X', '0x') }),
      tx({ to: `${chiado.vault}00` }),
      tx({ data: 'deadbeef' }),
      tx({ data: '0xABCD' }),
      tx({ data: '0xabc' }),
      tx({ value: 1 }),
    ]) {
      expectRefused(bad, 'malformed');
    }
    // A getter is not a data property: refused without being called.
    let reads = 0;
    const getter = { ...base };
    Object.defineProperty(getter, 'to', {
      enumerable: true,
      get() {
        reads += 1;
        return chiado.vault;
      },
    });
    expectRefused(getter, 'malformed');
    expect(reads).toBe(0);
    // A malformed own address.
    expectRefused(base, 'malformed', 'not-an-address');
    expectRefused(base, 'malformed', OWN.toUpperCase());
  });

  it('the refusal messages name no input', () => {
    for (const message of Object.values(TRANSACTION_REFUSED)) {
      expect(message).not.toMatch(/0x[0-9a-f]{6,}/i);
      expect(message).not.toMatch(/\d{5,}/);
    }
  });
});
