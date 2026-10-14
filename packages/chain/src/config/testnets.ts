// Launch testnets (03 §7; M1-14). Base Sepolia first (owner decision 2026-10-14), then Gnosis Chiado.
//
// Every entry cites its source and verification date. Token addresses were checked against the
// issuer's list and against chain state (symbol, decimals, EIP-3009 proven on a fork) by
// occ-v2-contracts script/verify-chain. RPC URLs are public and keyless (07 §6.1: no API keys in the
// client); users can override them.
import type { ChainNetwork } from './types.js';

const VERIFIED_ON = '2026-10-14';

/** Freezes a network entry and everything inside it, so no caller can redirect a payment. */
function frozen(n: ChainNetwork): ChainNetwork {
  for (const t of n.feeTokens) {
    Object.freeze(t.source);
    Object.freeze(t);
  }
  Object.freeze(n.feeTokens);
  Object.freeze(n.rpcUrls);
  Object.freeze(n.source);
  return Object.freeze(n);
}

/** Base Sepolia (84532). Fee token: Circle's USDC. Tether lists no testnet USDT. */
export const BASE_SEPOLIA: ChainNetwork = frozen({
  key: 'base-sepolia',
  chainId: 84532,
  rpcUrls: [
    'https://base-sepolia-rpc.publicnode.com',
    'https://sepolia.base.org',
    'https://base-sepolia.drpc.org',
  ],
  feeTokens: [
    {
      symbol: 'USDC',
      address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      decimals: 6,
      eip3009: true,
      source: {
        url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
        verifiedOn: VERIFIED_ON,
      },
    },
  ],
  explorer: 'https://sepolia.basescan.org',
  confirmations: 10,
  finalizedTag: true,
  testnet: true,
  source: {
    url: 'https://docs.base.org/base-chain/quickstart/connecting-to-base',
    verifiedOn: VERIFIED_ON,
  },
});

/**
 * Gnosis Chiado (10200). Fee token: the native xDAI (D-46). Circle and Tether list no USDC or USDT
 * on Chiado.
 */
export const GNOSIS_CHIADO: ChainNetwork = frozen({
  key: 'gnosis-chiado',
  chainId: 10200,
  rpcUrls: [
    'https://rpc.chiadochain.net',
    'https://gnosis-chiado-rpc.publicnode.com',
    'https://gnosis-chiado.drpc.org',
  ],
  feeTokens: [
    {
      symbol: 'NATIVE',
      address: null,
      decimals: 18,
      eip3009: false,
      source: {
        url: 'https://docs.gnosischain.com/about/networks/chiado',
        verifiedOn: VERIFIED_ON,
      },
    },
  ],
  explorer: 'https://gnosis-chiado.blockscout.com',
  confirmations: 12,
  finalizedTag: true,
  testnet: true,
  source: { url: 'https://docs.gnosischain.com/about/networks/chiado', verifiedOn: VERIFIED_ON },
});

/** The launch testnets, in deployment order. */
export const TESTNET_NETWORKS: readonly ChainNetwork[] = Object.freeze([
  BASE_SEPOLIA,
  GNOSIS_CHIADO,
]);
