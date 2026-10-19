// Fee quotes (07 §6.2; 12 §4 step 1, §5; 05 §2.2): `OCCFeeVault.quote(feeType, token, appId)`,
// shown in USD with the protocol and integrator parts separate. The quote is the contract's own,
// integrator cap included; the client only checks that the answer is possible and fails closed
// otherwise. Official clients use appId 0, so their integrator part is always 0 (12 §4.3).
import type { ChainConfig, ConfiguredFeeType, FeeTokenSymbol } from '../config/index.js';
import { feeVaultReader } from '../clients/calls.js';
import { ChainError } from '../clients/errors.js';
import type { ReadClient } from '../clients/read-client.js';
import { ChainInputError, type Hex } from '../ids/index.js';
import { offeredToken } from './tokens.js';
import { tokenUnitsToUsd } from './usd.js';

/** The configured fee types and their `FeeType` enum values (05 §2.2). */
export const FEE_TYPE_IDS = Object.freeze({ NOTARIZE: 0, REGISTER: 1 } as const);

/** The official clients' app ID: no integrator fee (12 §4.3). */
export const OFFICIAL_APP_ID: Hex = `0x${'0'.repeat(64)}`;

/** `MAX_INTEGRATOR_FEE_CAP_MULTIPLE`, a contract constant (05 §2.2, 12 §5): the cap never exceeds 10×. */
const MAX_CAP_MULTIPLE = 10n;

const APP_ID = /^0x[0-9a-fA-F]{64}$/;

export interface QuoteRequest {
  readonly feeType: ConfiguredFeeType;
  /** A fee token the chain offers (`feeTokens`, D-46). */
  readonly token: FeeTokenSymbol;
  /** Defaults to the official app (0). */
  readonly appId?: Hex;
}

/** A quote in token base units and in USD (12 §5: the parts shown separately). */
export interface FeeQuote {
  readonly chainId: number;
  readonly feeType: ConfiguredFeeType;
  readonly token: FeeTokenSymbol;
  /** `null` for the native coin. */
  readonly tokenAddress: string | null;
  readonly appId: Hex;
  readonly protocolPart: bigint;
  readonly integratorPart: bigint;
  readonly total: bigint;
  /** USD, rounded up to the micro-dollar. */
  readonly protocolUsd: string;
  readonly integratorUsd: string;
  readonly usd: string;
}

function checkRequest(request: QuoteRequest): { t: number; appId: Hex } {
  const feeType = request.feeType as string;
  if (!Object.hasOwn(FEE_TYPE_IDS, feeType)) {
    throw new ChainInputError('unsupported_fee_type', 'feeType: NOTARIZE or REGISTER');
  }
  const appId = request.appId ?? OFFICIAL_APP_ID;
  if (typeof appId !== 'string' || !APP_ID.test(appId)) {
    throw new ChainInputError('invalid_app_id', 'appId: 0x + 64 hex');
  }
  return {
    t: FEE_TYPE_IDS[feeType as ConfiguredFeeType],
    appId: appId.toLowerCase() as Hex,
  };
}

/** Quotes one paid action on one chain. Errors are ChainInputErrors (before any request) or ChainErrors. */
export async function quoteFee(
  client: ReadClient,
  config: ChainConfig,
  request: QuoteRequest,
): Promise<FeeQuote> {
  const { t, appId } = checkRequest(request);
  const { token, vaultAddress } = offeredToken(config, request.token);
  const [protocolPart, integratorPart, total] = await feeVaultReader(client, config).read.quote([
    t,
    vaultAddress,
    appId,
  ]);
  if (
    total !== protocolPart + integratorPart ||
    (appId === OFFICIAL_APP_ID && integratorPart !== 0n) ||
    integratorPart > MAX_CAP_MULTIPLE * protocolPart
  ) {
    throw new ChainError('bad_answer');
  }
  const protocolUsd = tokenUnitsToUsd(protocolPart, token.decimals, 'up');
  const integratorUsd = tokenUnitsToUsd(integratorPart, token.decimals, 'up');
  const usd = tokenUnitsToUsd(total, token.decimals, 'up');
  if (protocolUsd === null || integratorUsd === null || usd === null) {
    throw new ChainError('bad_answer');
  }
  return Object.freeze({
    chainId: config.chainId,
    feeType: request.feeType,
    token: token.symbol,
    tokenAddress: token.address,
    appId,
    protocolPart,
    integratorPart,
    total,
    protocolUsd,
    integratorUsd,
    usd,
  });
}
