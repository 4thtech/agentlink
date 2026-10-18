// Record IDs, nonces and salts (05 §3.3 step 2; 04 §5; D-61).
//
// The ABI encoding is viem's; hashing and randomness are @4thtech-io/crypto's (keccak256 from
// @noble/hashes, the platform CSPRNG), so this file implements no primitive (I-8). Errors never
// carry their input.
import { encodeHex0x, keccak256, randomBytes } from '@4thtech-io/crypto';
import { encodeAbiParameters, hexToBytes, isAddress } from 'viem';

/** `0x` + lowercase hex. */
export type Hex = `0x${string}`;

const MAX_UINT256 = (1n << 256n) - 1n;

/** An error in a chain-side input. `code` is stable; the message never contains the input. */
export class ChainInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChainInputError';
    this.code = code;
  }
}

/** True for `0x` + 40 hex, all lowercase or with a valid EIP-55 checksum. */
export function isEvmAddress(value: unknown): value is Hex {
  return (
    typeof value === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(value) &&
    (value === value.toLowerCase() || isAddress(value, { strict: true }))
  );
}

/** The address in the 05 §3.1 JSON form (lowercase); throws unless it is lowercase or EIP-55. */
export function canonicalAddress(value: unknown, field: string): Hex {
  if (!isEvmAddress(value)) {
    throw new ChainInputError(
      'invalid_address',
      `${field}: must be 0x + 40 hex, lowercase or EIP-55`,
    );
  }
  return value.toLowerCase() as Hex;
}

/** Throws unless `chainId` is a positive safe integer. */
export function checkChainId(chainId: unknown): number {
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw new ChainInputError('invalid_chain_id', 'chainId: must be a positive integer');
  }
  return chainId;
}

/** Throws unless `value` is an integer in [0, 2^256). */
export function checkUint256(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) {
    throw new ChainInputError('invalid_uint256', `${field}: must be a bigint from 0 to 2^256 - 1`);
  }
  return value;
}

/**
 * The Notary's record ID (05 §3.3 step 2):
 * `keccak256(abi.encode(block.chainid, address(this), r.signer, r.nonce))`, as `0x` + 64 lowercase
 * hex. `notary` is the Notary proxy, the address the contract sees as `address(this)`.
 */
export function computeRecordId(
  chainId: number,
  notary: string,
  signer: string,
  nonce: bigint,
): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [
      BigInt(checkChainId(chainId)),
      canonicalAddress(notary, 'notary'),
      canonicalAddress(signer, 'signer'),
      checkUint256(nonce, 'nonce'),
    ],
  );
  return encodeHex0x(keccak256(hexToBytes(encoded))) as Hex;
}

/** A random 256-bit Record nonce (05 §3.1: random, single use per signer). */
export function randomNonce(): bigint {
  return BigInt(encodeHex0x(randomBytes(32)));
}

/**
 * A fresh 32-byte commitment salt from the platform CSPRNG (04 §5, D-61). Never derived from a key,
 * the envelope or the recipient. The Record builder is its only caller in this package; it is not
 * re-exported from the package root.
 */
export function randomSalt(): Hex {
  return encodeHex0x(randomBytes(32)) as Hex;
}
