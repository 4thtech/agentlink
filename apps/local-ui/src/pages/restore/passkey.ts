// The restore's one gesture on a computer with no owner yet (04 §2.3.3; 08 §1): the same passkey
// creation as first run (platform authenticator, PRF), but the second get() (for authenticators that
// give a PRF output only on use) answers a NEW challenge that `apply/finish` hands back, so it is its
// own step here. The browser never signs and never derives a key; the PRF output goes to the local
// server once and the page's copy is zeroed after encoding.
import { encodeRegistration, passkeysAvailable } from '../first-run/passkey.js';
import type { Creation, PrfRequest } from './api.js';

export type GestureResult =
  | { readonly kind: 'ok'; readonly body: Uint8Array; readonly created: readonly Uint8Array[] }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' };

export type PrfResult =
  | { readonly kind: 'ok'; readonly body: Uint8Array }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' };

interface PrfFlag {
  readonly prf?: {
    readonly enabled?: boolean;
    readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView };
  };
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesOf(value: ArrayBuffer | ArrayBufferView | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

const refused = (error: unknown): { kind: 'cancelled' } | { kind: 'unsupported' } => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotSupportedError' || name === 'SecurityError'
    ? { kind: 'unsupported' }
    : { kind: 'cancelled' };
};

/** True when this browser can make a passkey at all (otherwise the page names the terminal). */
export const canRestoreHere = (): boolean => passkeysAvailable();

/** Creates the passkey for `localhost` with PRF; the browser draws its own dialog. */
export async function createRestorePasskey(
  values: Creation,
  options: { readonly platform: boolean } = { platform: true },
): Promise<GestureResult> {
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
    return refused(error);
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) {
    return { kind: 'cancelled' };
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getAuthenticatorData !== 'function') return { kind: 'unsupported' };
  const created = [
    new Uint8Array(credential.rawId),
    new Uint8Array(response.getAuthenticatorData()),
    new Uint8Array(response.clientDataJSON),
  ];
  const prf = bytesOf((credential.getClientExtensionResults() as PrfFlag).prf?.results?.first);
  try {
    return {
      kind: 'ok',
      created,
      body: encodeRegistration([...created, prf.length === 32 ? prf : new Uint8Array(0)]),
    };
  } finally {
    prf.fill(0);
  }
}

/** The second gesture (`prf_needed`): get() for the new credential; the body adds the assertion. */
export async function getRestorePrf(
  request: PrfRequest,
  created: readonly Uint8Array[],
): Promise<PrfResult> {
  // APP-CONTINUITY: never in the desktop app's window (passkeysAvailable is false there).
  if (!passkeysAvailable()) return { kind: 'unsupported' };
  let used: Credential | null;
  try {
    used = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(request.challenge),
        rpId: request.rpId,
        allowCredentials: [{ type: 'public-key', id: fromBase64url(request.credentialId) }],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: fromBase64url(request.prfSalt) } },
        } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    return refused(error);
  }
  if (used === null || !(used instanceof PublicKeyCredential)) return { kind: 'cancelled' };
  const asserted = used.response as AuthenticatorAssertionResponse;
  const second = bytesOf((used.getClientExtensionResults() as PrfFlag).prf?.results?.first);
  try {
    if (second.length !== 32) return { kind: 'unsupported' };
    return {
      kind: 'ok',
      body: encodeRegistration([
        ...created,
        second,
        new Uint8Array(used.rawId),
        new Uint8Array(asserted.authenticatorData),
        new Uint8Array(asserted.clientDataJSON),
        new Uint8Array(asserted.signature),
      ]),
    };
  } finally {
    second.fill(0);
  }
}
