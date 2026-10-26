// The one browser gesture of owner setup (D-120 (1); 04 §2.3.1; M1-11s-c): create a passkey for
// `localhost` with the PRF extension and hand the creation response to the server. The browser never
// signs and never derives a key: the PRF output goes to the local server once (it wraps the owner key
// there) and the page's copy is zeroed after encoding.
import type { CreationValues } from './setup-api.js';

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
export async function createSetupPasskey(values: CreationValues): Promise<PasskeyResult> {
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
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
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
