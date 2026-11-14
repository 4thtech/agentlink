// The one browser gesture of owner setup (D-120 (1); 04 §2.3.1; M1-11s-c): create a passkey for
// `localhost` with the PRF extension and hand the creation response to the server. The browser never
// signs and never derives a key: the PRF output goes to the local server once (it wraps the owner key
// there) and the page's copy is zeroed after encoding.
//
// M1-UX-FIRSTRUN-V2 (08 §1 first run v2): the passkey is asked of the platform authenticator
// (Touch ID, Windows Hello: `authenticatorAttachment: 'platform'`, `hints: ['client-device']`).
// Where the browser reports no PRF, the page offers "continue with a master code only", which asks
// for any passkey (no attachment): the gesture still proves presence, and the server keeps the
// master code as the way to approve.
//
// M1-11s-c-c (F48): where create() returns `prf.enabled` without a PRF output, a second gesture
// (get() for the new credential) follows at once in the same owner operation; its PRF output and
// assertion go to `finish`, which checks the assertion before using the output.
import type { CreationValues, UpgradeValues } from './setup-api.js';
import type { Platform } from './strings.js';
import { webAuthnHere } from '../../presence/webauthn-here.js';

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
  if (/mac|darwin/i.test(named)) return 'mac';
  if (/win/i.test(named)) return 'windows';
  return 'other';
}

/**
 * M1-UX-PRF-MATRIX detection: `no` when the browser says there is no platform authenticator with
 * user verification, or (where it can tell) no PRF; `unknown` when it can't tell (the server then
 * learns it from the creation response, and without PRF the master code stays the way to approve).
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

/**
 * FIRSTRUN-ANY-PLATFORM: how first run asks for presence, decided before anything is asked.
 * - `native`: the desktop app's own Touch ID / Windows Hello (the shell's helper is available): the
 *   master code is made with no WebAuthn call, then the native switch is offered at once.
 * - `passkey`: the browser's platform authenticator with PRF, one gesture; the master code stays
 *   the alternative.
 * - `code`: the master code only, with no WebAuthn call at all.
 * `passkeyOffered`: whether the platform passkey may be offered at all (primary or alternative).
 */
export interface SetupChoice {
  readonly primary: 'native' | 'passkey' | 'code';
  readonly passkeyOffered: boolean;
}

export function setupChoice(input: {
  readonly platform: Platform;
  readonly prf: PrfSupport;
  readonly passkeys: boolean;
  readonly native: boolean;
}): SetupChoice {
  if (input.native) return { primary: 'native', passkeyOffered: false };
  if (!input.passkeys || input.prf === 'no') return { primary: 'code', passkeyOffered: false };
  // Windows: a create with PRF can end on "Insert your security key" where Windows Hello has no PRF
  // (21H2): the master code first; Windows Hello only as the alternative, and only on a clear yes.
  if (input.platform === 'windows') {
    return { primary: 'code', passkeyOffered: input.prf === 'yes' };
  }
  if (input.prf === 'yes' || (input.platform === 'mac' && input.prf === 'unknown')) {
    return { primary: 'passkey', passkeyOffered: true };
  }
  return { primary: 'code', passkeyOffered: false };
}

/** Whether the switch to a passkey (an owner with a master code) is offered here (same rule). */
export function passkeySwitchOffered(platform: Platform, prf: PrfSupport): boolean {
  return prf === 'yes' || (platform === 'mac' && prf === 'unknown');
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
 * M1-11s-c-c: when the PRF output came from a get(), that get()'s credential ID, authenticator data,
 * clientDataJSON and signature follow in the same form.
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
  // APP-CONTINUITY: never in the desktop app's window (presence/webauthn-here.ts).
  return (
    webAuthnHere() &&
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined &&
    typeof navigator.credentials.create === 'function'
  );
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
  const created = [
    new Uint8Array(credential.rawId),
    new Uint8Array(response.getAuthenticatorData()),
    new Uint8Array(response.clientDataJSON),
  ];
  const ext = credential.getClientExtensionResults() as PrfFlag;
  const prf = bytesOf(ext.prf?.results?.first);
  try {
    if (prf.length === 32 || ext.prf?.enabled !== true) {
      return {
        kind: 'ok',
        body: encodeRegistration([...created, prf.length === 32 ? prf : new Uint8Array(0)]),
      };
    }
  } finally {
    prf.fill(0);
  }
  // M1-11s-c-c (F48; 04 §2.5; 08 §1): PRF only on use (Windows Hello, some iCloud Keychain paths).
  // The second gesture follows at once, in the same owner operation: get() for the new credential
  // only, user verification required, the same salt and the begin's challenge. Its assertion goes
  // with the PRF output so the server can check the gesture (signature with the creation's key).
  let used: Credential | null;
  try {
    used = await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64url(values.challenge),
        rpId: values.rpId,
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(credential.rawId) }],
        userVerification: 'required',
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
  if (used === null || !(used instanceof PublicKeyCredential)) return { kind: 'cancelled' };
  const asserted = used.response as AuthenticatorAssertionResponse;
  const second = bytesOf((used.getClientExtensionResults() as PrfFlag).prf?.results?.first);
  try {
    if (second.length !== 32) {
      // No PRF on use either: the creation alone, and the master code is the way to approve.
      return { kind: 'ok', body: encodeRegistration([...created, new Uint8Array(0)]) };
    }
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

// --- M1-UX-FIRSTRUN-V2-c (B-9): the passkey for an owner who already has a master code ----------
//
// The approval server's existing registration (owner-passkey.ts registerOwnerPasskey) takes an
// assertion body: credential ID, authenticator data, user handle (the owner key) and the 32-byte PRF
// output, each after its 16-bit length (encodePasskeyAssertion). The server checks rpIdHash, UP, UV
// and the user handle, then opens the `owner` item with the master code and seals the same owner key
// under the PRF output. The challenge is the page's own: the server relies on the PRF output (the
// presence proof is the successful decryption), never on the signature (04 §2.3.1, M1-8e).

export type UpgradePasskeyResult =
  | { readonly kind: 'ok'; readonly body: Uint8Array }
  | { readonly kind: 'cancelled' }
  /** No passkey, or no PRF from it: nothing is sent, the master code stays the way to approve. */
  | { readonly kind: 'unsupported' };

function challenge(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function cancelledOrUnsupported(error: unknown): UpgradePasskeyResult {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotSupportedError' || name === 'SecurityError') return { kind: 'unsupported' };
  return { kind: 'cancelled' };
}

interface PrfFlag {
  readonly prf?: {
    readonly enabled?: boolean;
    readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView };
  };
}

/**
 * Creates the owner's passkey for `localhost` (platform authenticator unless `platform` is false)
 * and returns the assertion body. Where the authenticator evaluates PRF only when the passkey is used
 * (`prf.enabled` without results), one more gesture follows with the new credential (08 §1).
 */
export async function createUpgradePasskey(
  values: UpgradeValues,
  options: PasskeyOptions = { platform: true },
): Promise<UpgradePasskeyResult> {
  if (!passkeysAvailable()) return { kind: 'unsupported' };
  const userId = fromBase64url(values.userId);
  const salt = fromBase64url(values.prfSalt);
  const extensions = { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs;
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: values.rpId, name: 'AgentLink' },
        user: { id: userId, name: 'AgentLink owner', displayName: 'AgentLink owner' },
        challenge: challenge(),
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
        extensions,
      },
    });
  } catch (error) {
    return cancelledOrUnsupported(error);
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) {
    return { kind: 'cancelled' };
  }
  const created = credential.response as AuthenticatorAttestationResponse;
  if (typeof created.getAuthenticatorData !== 'function') return { kind: 'unsupported' };
  const ext = credential.getClientExtensionResults() as PrfFlag;
  const prf = bytesOf(ext.prf?.results?.first);
  try {
    if (prf.length === 32) {
      return {
        kind: 'ok',
        body: encodeRegistration([
          new Uint8Array(credential.rawId),
          new Uint8Array(created.getAuthenticatorData()),
          userId,
          prf,
        ]),
      };
    }
  } finally {
    prf.fill(0);
  }
  if (ext.prf?.enabled !== true) return { kind: 'unsupported' };
  // PRF only on use: one more gesture with the new credential.
  let used: Credential | null;
  try {
    used = await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        rpId: values.rpId,
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(credential.rawId) }],
        userVerification: 'required',
        extensions,
      },
    });
  } catch (error) {
    return cancelledOrUnsupported(error);
  }
  if (used === null || !(used instanceof PublicKeyCredential)) return { kind: 'cancelled' };
  const asserted = used.response as AuthenticatorAssertionResponse;
  const second = bytesOf((used.getClientExtensionResults() as PrfFlag).prf?.results?.first);
  try {
    if (second.length !== 32) return { kind: 'unsupported' };
    return {
      kind: 'ok',
      // M1-PAY-CONFIRM-b: this get() carries no credential key, so the create() authenticator
      // data goes along as a fifth field; the server keeps the key from it for paid actions
      // (04 §2.5.3 rule 5). Without it such an owner could confirm paid actions only by code.
      body: encodeRegistration([
        new Uint8Array(used.rawId),
        new Uint8Array(asserted.authenticatorData),
        asserted.userHandle === null ? userId : new Uint8Array(asserted.userHandle),
        second,
        new Uint8Array(created.getAuthenticatorData()),
      ]),
    };
  } finally {
    second.fill(0);
  }
}

/**
 * The registration body of `POST /api/owner/passkey` (owner-passkey.ts parsePasskeyRegistration):
 * the master code after its 16-bit big-endian length, then the assertion body. The caller zeroes
 * both inputs and the result.
 */
export function encodeUpgradeBody(code: Uint8Array, assertion: Uint8Array): Uint8Array {
  if (code.length === 0 || code.length > 1024) throw new Error('code length');
  const out = new Uint8Array(2 + code.length + assertion.length);
  out[0] = code.length >> 8;
  out[1] = code.length & 0xff;
  out.set(code, 2);
  out.set(assertion, 2 + code.length);
  return out;
}
