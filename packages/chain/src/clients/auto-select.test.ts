// M1-3j-b: Gnosis Chiado (10200) joins automatic selection (07 §6.3, D-40, D-46), gated on the
// testnet faucet. Automatic selection uses exactly the registry chains the faucet serves
// (`isFaucetChain`), so an unfunded payer is never routed to a chain where it cannot get credits.
// This file plays the release where the faucet allowlist names Chiado (a mocked `fees/faucet.js`;
// everything else is real): Chiado is then picked, with the documented tie-break, and its top-up
// path is the faucet's native xDAI `depositFor`. The shipped allowlist is pinned in clients.test.ts.
import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ChainConfig, FeeTokenSymbol } from '../config/index.js';
import type { FeeQuote } from '../fees/index.js';
import { buildDepositFor, isFaucetChain } from '../fees/faucet.js';
import { pickChain, type ChainFunding, type FundingDetection } from '../select/index.js';
import { autoSelectableChains, chainRegistry, getChainConfig } from './index.js';
import { autoSelectableFrom } from './registry.js';

vi.mock('../fees/faucet.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../fees/faucet.js')>();
  const ids: readonly number[] = Object.freeze([84532, 10200]);
  return {
    ...real,
    FAUCET_CHAIN_IDS: ids,
    isFaucetChain: (chainId: unknown) =>
      typeof chainId === 'number' && Number.isSafeInteger(chainId) && ids.includes(chainId),
  };
});

const PAYER: Hex = `0x${'11'.repeat(20)}`;
const CENT = 10_000n;

function quoteOf(config: ChainConfig, micros: bigint): FeeQuote {
  const t = config.feeTokens[0];
  if (!t) throw new Error('no fee token');
  const total = micros * 10n ** BigInt(t.decimals - 6);
  const usd = (Number(micros) / 1e6).toString();
  return Object.freeze({
    chainId: config.chainId,
    feeType: 'NOTARIZE',
    token: t.symbol,
    tokenAddress: t.address,
    appId: `0x${'0'.repeat(64)}` as Hex,
    protocolPart: total,
    integratorPart: 0n,
    total,
    protocolUsd: usd,
    integratorUsd: '0',
    usd,
  });
}

/** Every automatically selectable chain at the same fee, with `credits` micro-dollars on each. */
function sameFee(fee: bigint, credits: bigint): FundingDetection {
  const chains: ChainFunding[] = autoSelectableChains().map((config) => {
    const t = config.feeTokens[0];
    const scale = 10n ** BigInt((t?.decimals ?? 6) - 6);
    return {
      config,
      options: [{ quote: quoteOf(config, fee), credits: credits * scale, topUpBalance: null }],
    };
  });
  return { payer: PAYER, chains, unavailable: [] };
}

describe('automatic selection once the faucet serves Gnosis Chiado (M1-3j-b)', () => {
  it('selects every registry chain the faucet serves, Chiado included', () => {
    const ids = autoSelectableChains().map((c) => c.chainId);
    expect([...ids].sort((a, b) => a - b)).toEqual([10200, 84532]);
    expect(ids).toEqual(
      chainRegistry()
        .filter((c) => isFaucetChain(c.chainId))
        .map((c) => c.chainId),
    );
  });

  it('an unfunded payer at equal fees gets the documented tie-break: the lower chain ID, Chiado', () => {
    const picked = pickChain(sameFee(5n * CENT, 0n));
    expect(picked).toMatchObject({
      status: 'needs_credits',
      topUp: { chainId: 10200, chain: 'gnosis-chiado', token: 'NATIVE', agentAddress: PAYER },
    });
  });

  it('the top-up route lands on a chain the faucet serves, with its native xDAI depositFor', () => {
    const picked = pickChain(sameFee(5n * CENT, 0n));
    if (picked.status !== 'needs_credits') throw new Error('expected needs_credits');
    expect(isFaucetChain(picked.topUp.chainId)).toBe(true);
    const chiado = getChainConfig(picked.topUp.chainId) as ChainConfig;
    const steps = buildDepositFor(chiado, {
      agent: PAYER,
      token: picked.topUp.token as FeeTokenSymbol,
      amount: 10n ** 18n,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      purpose: 'deposit',
      to: chiado.contracts.vault,
      value: 10n ** 18n,
    });
  });

  it('funded on both at equal fees: Chiado (lower chain ID) pays', () => {
    expect(pickChain(sameFee(5n * CENT, 100n * CENT))).toMatchObject({
      status: 'ok',
      chainId: 10200,
    });
  });

  it('fails closed on a non-testnet entry, even with its chain ID on the faucet allowlist', () => {
    const chiado = getChainConfig(10200) as ChainConfig;
    const asMainnet: ChainConfig = { ...chiado, testnet: false };
    expect(isFaucetChain(asMainnet.chainId)).toBe(true);
    expect(autoSelectableFrom([asMainnet]).map((c) => c.chainId)).toEqual([]);
    expect(autoSelectableFrom([asMainnet, chiado]).map((c) => c.chainId)).toEqual([10200]);
  });
});
