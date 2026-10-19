// Settings of the submitter Worker (07 §7; 05 §3.3; FA-1). The defaults are the spec's; each
// override is bounded. Any invalid value makes readConfig return null, and the Worker fails closed
// (`unavailable`), never running with a guessed setting.
//
// Vars (wrangler.toml, reviewed in PRs): SUBMITTER_CHAINS and the optional overrides below.
// Worker secrets (set by the owner with `wrangler secret put`, never in a file; M1-10c):
//   SUBMITTER_IP_KEY             32 random bytes, base64url: the per-IP rate bucket HMAC key
//   SUBMITTER_GAS_KEY_<chainId>  the chain's gas key, 0x + 64 hex (a hot key, low balance)
//   SUBMITTER_RPC_URLS_<chainId> optional: comma-separated RPC URLs (may carry a provider key)
// Optional var SUBMITTER_MAX_FEE_PER_GAS_WEI: a ceiling on every transaction's maxFeePerGas.
import { decodeBase64url } from '@4thtech-io/crypto';
import { getChainConfig } from '@4thtech-io/chain';
import type { EngineSettings } from './engine.js';

export interface Limits {
  /** Items accepted per IP (IPv6 /64) per hour, all items counted (FA-3: replays count here). */
  readonly ipItemsPerHour: number;
  /** New items (not already on-chain) per signer per chain per hour. */
  readonly signerItemsPerHour: number;
  /** `/v1/status` and `/v1/health` requests per IP (IPv6 /64) per hour. */
  readonly ipReadsPerHour: number;
}

export interface SubmitterConfig {
  /** Served chain IDs: supported testnets only (M1-10a). */
  readonly chains: readonly number[];
  readonly settings: EngineSettings;
  readonly limits: Limits;
  /** The per-IP bucket key. */
  readonly ipKey: Uint8Array;
  /** Optional ceiling on any transaction's `maxFeePerGas`, in wei; null: none. */
  readonly maxFeePerGasWei: bigint | null;
}

export const DEFAULTS = Object.freeze({
  /** FA-1: a small fixed margin over the simulated gas, never a large default. */
  gasMargin: 25_000n,
  /**
   * H-1: the most simulated gas one item may use alone. The planned bound on the gas forwarded to
   * isValidSignature (500 000, M3-1a) plus a notarize with credits (05 §3.4: at most 170 000) and
   * a reserve for the batch call, rounded up.
   */
  maxItemGas: 700_000n,
  /** M-2: no receipt after this long: replace with raised fees. */
  stuckAfterSeconds: 180,
  /** M-2: replacements before a transaction counts as dropped and its items are queued again. */
  maxReplacements: 3,
  /** D-62: 1 h. */
  soloAfterRevertSeconds: 3_600,
  codeSignerMode: 'solo' as const,
  /** The 05 §3.4 batch gas target is for n = 20. */
  maxBatch: 20,
  /** Finished items and transactions are kept a day for `/v1/status`. */
  retentionSeconds: 86_400,
  ipItemsPerHour: 600,
  signerItemsPerHour: 120,
  ipReadsPerHour: 600,
});

const DECIMAL_WEI = /^[1-9][0-9]{0,17}$/;

const INTEGER = /^(0|[1-9][0-9]{0,8})$/;

function intVar(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !INTEGER.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** Reads and checks the settings; null when anything is missing or out of bounds. */
export function readConfig(env: Record<string, unknown>): SubmitterConfig | null {
  const chainsRaw = env.SUBMITTER_CHAINS;
  if (typeof chainsRaw !== 'string' || chainsRaw === '') return null;
  const chains: number[] = [];
  for (const part of chainsRaw.split(',')) {
    if (!INTEGER.test(part)) return null;
    const chainId = Number(part);
    const config = getChainConfig(chainId);
    if (!config || !config.testnet || chains.includes(chainId)) return null;
    chains.push(chainId);
  }
  const ipKeyRaw = env.SUBMITTER_IP_KEY;
  if (typeof ipKeyRaw !== 'string') return null;
  let ipKey: Uint8Array;
  try {
    ipKey = decodeBase64url(ipKeyRaw);
  } catch {
    return null;
  }
  if (ipKey.length !== 32) return null;

  const gasMargin = intVar(env, 'SUBMITTER_GAS_MARGIN', Number(DEFAULTS.gasMargin), 0, 200_000);
  const solo = intVar(
    env,
    'SUBMITTER_SOLO_AFTER_REVERT_SECONDS',
    DEFAULTS.soloAfterRevertSeconds,
    60,
    7 * 86_400,
  );
  const maxBatch = intVar(env, 'SUBMITTER_MAX_BATCH', DEFAULTS.maxBatch, 1, 20);
  const maxItemGas = intVar(
    env,
    'SUBMITTER_MAX_ITEM_GAS',
    Number(DEFAULTS.maxItemGas),
    100_000,
    2_000_000,
  );
  const stuck = intVar(env, 'SUBMITTER_STUCK_AFTER_SECONDS', DEFAULTS.stuckAfterSeconds, 30, 3_600);
  const replacements = intVar(env, 'SUBMITTER_MAX_REPLACEMENTS', DEFAULTS.maxReplacements, 0, 10);
  const reads = intVar(env, 'SUBMITTER_IP_READS_PER_HOUR', DEFAULTS.ipReadsPerHour, 1, 100_000);
  const feeRaw = env.SUBMITTER_MAX_FEE_PER_GAS_WEI;
  let maxFeePerGasWei: bigint | null = null;
  if (feeRaw !== undefined && feeRaw !== '') {
    if (typeof feeRaw !== 'string' || !DECIMAL_WEI.test(feeRaw)) return null;
    maxFeePerGasWei = BigInt(feeRaw);
  }
  const ipItems = intVar(env, 'SUBMITTER_IP_ITEMS_PER_HOUR', DEFAULTS.ipItemsPerHour, 1, 100_000);
  const signerItems = intVar(
    env,
    'SUBMITTER_SIGNER_ITEMS_PER_HOUR',
    DEFAULTS.signerItemsPerHour,
    1,
    10_000,
  );
  const mode = env.SUBMITTER_CODE_SIGNER_MODE ?? DEFAULTS.codeSignerMode;
  if (mode !== 'solo' && mode !== 'one-per-batch') return null;
  if (
    gasMargin === null ||
    solo === null ||
    maxBatch === null ||
    maxItemGas === null ||
    stuck === null ||
    replacements === null ||
    reads === null ||
    ipItems === null ||
    signerItems === null
  ) {
    return null;
  }
  return Object.freeze({
    chains: Object.freeze(chains),
    settings: Object.freeze({
      gasMargin: BigInt(gasMargin),
      soloAfterRevertSeconds: solo,
      codeSignerMode: mode,
      maxBatch,
      retentionSeconds: DEFAULTS.retentionSeconds,
      maxItemGas: BigInt(maxItemGas),
      stuckAfterSeconds: stuck,
      maxReplacements: replacements,
    }),
    limits: Object.freeze({
      ipItemsPerHour: ipItems,
      signerItemsPerHour: signerItems,
      ipReadsPerHour: reads,
    }),
    ipKey,
    maxFeePerGasWei,
  });
}
