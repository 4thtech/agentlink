// The one browser gesture of owner setup (D-120 (1); 04 §2.3.1; M1-11s-c): create a passkey for
// `localhost` with the PRF extension and hand the creation response to the server. The browser never
// signs and never derives a key: the PRF output goes to the local server once (it wraps the owner key
// there) and the page's copy is zeroed after encoding.
//
// M1-UX-FIRSTRUN-V2 (08 §1 first run v2): the passkey is asked of the platform authenticator
// (Touch ID, Windows Hello: `authenticatorAttachment: 'platform'`, `hints: ['client-device']`).
// Where the browser reports no PRF, the page offers "continue with a backup code only", which asks
// for any passkey (no attachment): the gesture still proves presence, and the server keeps the
// backup code as the way to approve.
import type { CreationValues } from './setup-api.js';
import type { Platform } from './strings.js';

/** How the passkey is asked for. */
export interface PasskeyOptions {
  /** True: the platform authenticator only (the default flow). False: any passkey. */
  readonly platform: boolean;
}

/** Whether this browser reports a passkey with PRF on this computer. */
export type PrfSupport = 'yes' | 'no' | 'unknown';

/** The platform, from the browser's own report (never sent anywhere). */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const data = (navigator as { userAgentData?: { platform?: unknown } }).userAgentData;
  const named = typeof data?.platform === 'string' ? data.platform : navigator.userAgent;
  if (/mac/i.test(named)) return 'mac';
  if (/win/i.test(named)) return 'windows';
  return 'other';
}

/**
 * M1-UX-PRF-MATRIX detection: `no` when the browser says there is no platform authenticator with
 * user verification, or (where it can tell) no PRF; `unknown` when it can't tell (the server then
 * learns it from the creation response, and without PRF the backup code stays the way to approve).
 */
export async function prfSupport(): Promise<PrfSupport> {
  if (!passkeysAvailable()) return 'no';
  const pkc = window.PublicKeyCredential as unknown as {
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  };
  try {
    if (
      typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable === 'function' &&
      !(await pkc.isUserVerifyingPlatformAuthenticatorAvailable())
    ) {
      return 'no';
    }
    if (typeof pkc.getClientCapabilities === 'function') {
      const caps = await pkc.getClientCapabilities();
      if (caps['extension:prf'] === false) return 'no';
      if (caps['extension:prf'] === true) return 'yes';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export type PasskeyResult =
  | { readonly kind: 'ok'; readonly body: Uint8Array }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' };

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The `finish` body (owner-setup.ts encodeSetupRegistration): credential ID, authenticator data,
 * clientDataJSON and the PRF output (empty without PRF), each after its 16-bit big-endian length.
 */
export function encodeRegistration(fields: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const field of fields) {
    if (field.length > 0xffff) throw new Error('field too long');
    out[at] = field.length >> 8;
    out[at + 1] = field.length & 0xff;
    out.set(field, at + 2);
    at += 2 + field.length;
  }
  return out;
}

/** True when this browser can make a passkey at all. */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined &&
    typeof navigator.credentials.create === 'function'
  );
}

interface PrfResults {
  readonly prf?: { readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView } };
}

function bytesOf(value: ArrayBuffer | ArrayBufferView | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

/** Creates the passkey; the browser draws its own dialog. */
export async function createSetupPasskey(
  values: CreationValues,
  options: PasskeyOptions = { platform: true },
): Promise<PasskeyResult> {
  if (!passkeysAvailable()) return { kind: 'unsupported' };
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: values.rpId, name: values.rpName },
        user: {
          id: fromBase64url(values.userId),
          name: values.userName,
          displayName: values.userName,
        },
        challenge: fromBase64url(values.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          ...(options.platform ? { authenticatorAttachment: 'platform' as const } : {}),
          residentKey: 'required',
          userVerification: 'required',
        },
        ...(options.platform ? { hints: ['client-device'] } : {}),
        attestation: 'none',
        extensions: {
          prf: { eval: { first: fromBase64url(values.prfSalt) } },
        } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'NotSupportedError' || name === 'SecurityError') return { kind: 'unsupported' };
    return { kind: 'cancelled' };
  }
  if (credential === null || !(credential instanceof PublicKeyCredential))
    return { kind: 'cancelled' };
  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getAuthenticatorData !== 'function') return { kind: 'unsupported' };
  const prf = bytesOf((credential.getClientExtensionResults() as PrfResults).prf?.results?.first);
  try {
    return {
      kind: 'ok',
      body: encodeRegistration([
        new Uint8Array(credential.rawId),
        new Uint8Array(response.getAuthenticatorData()),
        new Uint8Array(response.clientDataJSON),
        prf.length === 32 ? prf : new Uint8Array(0),
      ]),
    };
  } finally {
    prf.fill(0);
  }
}
