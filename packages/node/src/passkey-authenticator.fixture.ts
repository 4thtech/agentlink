// M1-8e test seam: a virtual WebAuthn authenticator with the PRF extension, standing in for the
// owner's platform passkey (no real hardware in CI). Not part of the build (tsconfig.json excludes
// *.fixture.ts).
//
// It returns what the localhost page sends to the approval server after a WebAuthn ceremony: the
// credential ID, the authenticator data (rpIdHash ‖ flags ‖ signCount), the user handle and the
// 32-byte PRF output for the owner's PRF salt. The PRF is simulated as a keyed function of a
// per-credential secret that never leaves this object, as a real authenticator's PRF secret never
// leaves the device; only its output for one salt is handed out, after a simulated gesture.
import { concatBytes, encodeUtf8, hkdfSha256, randomBytes, sha256 } from '@4thtech-io/crypto';
import type { PasskeyAssertion } from './owner-passkey.js';

export interface VirtualAuthenticatorOptions {
  /** Whether the authenticator supports the PRF extension (default true). */
  readonly prf?: boolean;
  /** The RP ID it signs its authenticator data for (default `localhost`). */
  readonly rpId?: string;
  /** User present flag (default true). */
  readonly up?: boolean;
  /** User verified flag (default true). */
  readonly uv?: boolean;
  /**
   * M1-PAY-CONFIRM-a: the credential's signing key (a test passes `newWebauthnTestCredential()` from
   * the crypto test seam). With it, `create` returns attested credential data with its COSE_Key and
   * `sign` signs assertions; without it, neither (the earlier behaviour).
   */
  readonly credential?: VirtualCredential;
}

/** An authenticator's own key, as the crypto test seam makes it. */
export interface VirtualCredential {
  readonly coseKey: Uint8Array;
  sign(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/** One virtual passkey: created for one user handle, asked for PRF outputs after a gesture. */
export class VirtualPrfAuthenticator {
  readonly credentialId: Uint8Array = randomBytes(16);
  readonly #prfSecret: Uint8Array = randomBytes(32);
  readonly #credential: VirtualCredential | undefined;
  readonly #options: Required<Omit<VirtualAuthenticatorOptions, 'credential'>>;
  #userHandle: Uint8Array | undefined;
  #signCount = 0;
  /** Gestures made (each create or get is one). */
  gestures = 0;

  constructor(options: VirtualAuthenticatorOptions = {}) {
    this.#credential = options.credential;
    this.#options = {
      prf: options.prf ?? true,
      rpId: options.rpId ?? 'localhost',
      up: options.up ?? true,
      uv: options.uv ?? true,
    };
  }

  #authenticatorData(attested: boolean): Uint8Array {
    this.#signCount += 1;
    let flags = 0;
    if (this.#options.up) flags |= FLAG_UP;
    if (this.#options.uv) flags |= FLAG_UV;
    if (attested) flags |= FLAG_AT;
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.#signCount, false);
    const head = concatBytes(
      sha256(encodeUtf8(this.#options.rpId)),
      new Uint8Array([flags]),
      count,
    );
    if (!attested || this.#credential === undefined) return head;
    // Attested credential data: aaguid (16 zero bytes), credential ID length and ID, COSE_Key.
    const id = this.credentialId;
    return concatBytes(
      head,
      new Uint8Array(16),
      new Uint8Array([id.length >> 8, id.length & 0xff]),
      id,
      this.#credential.coseKey,
    );
  }

  #prf(salt: Uint8Array): Uint8Array {
    return hkdfSha256(this.#prfSecret, salt, encodeUtf8('virtual-authenticator-prf'), 32);
  }

  /** navigator.credentials.create with `prf.eval.first = salt`, for `userId` (= user.id). */
  create(userId: Uint8Array, salt: Uint8Array): PasskeyAssertion {
    this.gestures += 1;
    this.#userHandle = userId.slice();
    return Object.freeze({
      credentialId: this.credentialId.slice(),
      authenticatorData: this.#authenticatorData(true),
      userHandle: userId.slice(),
      prfOutput: this.#options.prf ? this.#prf(salt) : new Uint8Array(0),
    });
  }

  /** navigator.credentials.get with `allowCredentials = [this]` and `prf.eval.first = salt`. */
  get(salt: Uint8Array): PasskeyAssertion {
    this.gestures += 1;
    if (this.#userHandle === undefined) throw new Error('virtual authenticator: not created');
    return Object.freeze({
      credentialId: this.credentialId.slice(),
      authenticatorData: this.#authenticatorData(false),
      userHandle: this.#userHandle.slice(),
      prfOutput: this.#options.prf ? this.#prf(salt) : new Uint8Array(0),
    });
  }

  /** The assertion signature over authenticatorData ‖ SHA-256(clientDataJSON) (DER, ES256). */
  /** The credential public key (COSE_Key), when it has a credential key. */
  get coseKey(): Uint8Array | undefined {
    return this.#credential?.coseKey;
  }

  sign(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
    if (this.#credential === undefined) throw new Error('virtual authenticator: no credential key');
    return this.#credential.sign(authenticatorData, clientDataJSON);
  }
}
