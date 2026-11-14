import { pageCredentials } from '../presence/webauthn-here.js';
// REL051-SF1 (04 §2.5; 08 §1; packages/node presence-ceremony.ts): the page side of the presence
// ceremony. A passkey proof answers a fresh challenge the server issued for exactly the request the
// page is about to send:
// 1. the page sends the same request (path, CSRF, `X-AgentLink-Input` and every other header) with
//    `X-AgentLink-Presence: challenge` and an empty body; the server answers `ready`, a ceremony ID
//    and the WebAuthn request values, or a refusal (a wait, an expired session, no usable passkey);
// 2. one `navigator.credentials.get` with that challenge, only after the owner clicked;
// 3. the request again with `X-AgentLink-Presence: passkey`, `X-AgentLink-Ceremony` and the six
//    fields (credential ID, authenticator data, clientDataJSON, signature, user handle, PRF output),
//    each after its 16-bit big-endian length.
// A refusal at step 1 is handed back as the answer of the request, so every caller maps it as it maps
// any other answer. A dismissed or PRF-less gesture is answered `presence_required` (nothing was
// sent): the sheet offers the passkey and the master code again. Nothing here is logged; the bytes
// are wiped once sent.
//
// DESK051-C6 (04 §2.5 "Desktop app owner presence"): native presence (Touch ID / Windows Hello in
// the desktop app) answers a ceremony too. The page asks with `X-AgentLink-Presence:
// native-challenge`; the server answers `ready` and a ceremony ID (no WebAuthn values: the server
// runs the OS gesture itself); the request then goes with `X-AgentLink-Presence: native`,
// `X-AgentLink-Ceremony` and an empty body. The ceremony is spent before the gesture, so a replayed
// native request is refused before any sheet appears.

/** The WebAuthn request values the server answered for one ceremony. */
export interface CeremonyPublicKey {
  readonly challenge: string;
  readonly allowCredentials: readonly string[];
  readonly prfSalt: string;
  readonly timeoutMs: number;
}

/** One passkey gesture for a ceremony: the six-field body, or undefined (dismissed, no PRF). */
export type CeremonyGesture = (publicKey: CeremonyPublicKey) => Promise<Uint8Array | undefined>;

export const PRESENCE_HEADER = 'X-AgentLink-Presence';
export const CEREMONY_HEADER = 'X-AgentLink-Ceremony';

const B64URL = /^[A-Za-z0-9_-]+$/;
const CEREMONY = /^[A-Za-z0-9_-]{22}$/;

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Bytes, each field after its 16-bit big-endian length. */
export function lengthPrefixed(list: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(list.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const f of list) {
    out[at] = f.length >> 8;
    out[at + 1] = f.length & 255;
    out.set(f, at + 2);
    at += 2 + f.length;
  }
  return out;
}

const bytes = (buffer: ArrayBuffer | null | undefined): Uint8Array =>
  buffer ? new Uint8Array(buffer) : new Uint8Array(0);

/** The ceremony answer's request values, or undefined when anything is malformed. */
export function ceremonyPublicKeyOf(value: unknown): CeremonyPublicKey | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const list = v['allowCredentials'];
  if (
    v['rpId'] !== 'localhost' ||
    typeof v['challenge'] !== 'string' ||
    !B64URL.test(v['challenge']) ||
    typeof v['prfSalt'] !== 'string' ||
    !B64URL.test(v['prfSalt']) ||
    typeof v['timeoutMs'] !== 'number' ||
    !Array.isArray(list) ||
    list.length > 1 ||
    !list.every((id) => typeof id === 'string' && B64URL.test(id))
  ) {
    return undefined;
  }
  return {
    challenge: v['challenge'],
    allowCredentials: list as string[],
    prfSalt: v['prfSalt'],
    timeoutMs: v['timeoutMs'],
  };
}

/**
 * The browser's gesture for a ceremony: RP ID `localhost`, the server's challenge, the stored
 * credential, user verification required and the PRF extension over the owner's PRF salt.
 */
export async function browserCeremonyGesture(
  publicKey: CeremonyPublicKey,
  // APP-CONTINUITY: never in the desktop app's window (presence/webauthn-here.ts).
  container: CredentialsContainer | undefined = pageCredentials(),
): Promise<Uint8Array | undefined> {
  if (container === undefined) return undefined;
  try {
    const credential = (await container.get({
      publicKey: {
        challenge: fromBase64url(publicKey.challenge),
        rpId: 'localhost',
        allowCredentials: publicKey.allowCredentials.map((id) => ({
          type: 'public-key' as const,
          id: fromBase64url(id),
        })),
        userVerification: 'required',
        timeout: publicKey.timeoutMs,
        extensions: { prf: { eval: { first: fromBase64url(publicKey.prfSalt) } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (credential === null) return undefined;
    const ext = credential.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } };
    };
    const prf = bytes(ext.prf?.results?.first);
    if (prf.length === 0) return undefined;
    const response = credential.response as AuthenticatorAssertionResponse;
    const body = lengthPrefixed([
      bytes(credential.rawId),
      bytes(response.authenticatorData),
      bytes(response.clientDataJSON),
      bytes(response.signature),
      bytes(response.userHandle),
      prf,
    ]);
    prf.fill(0);
    return body;
  } catch {
    return undefined;
  }
}

const presenceRequired = (): Response =>
  new Response(JSON.stringify({ status: 'presence_required' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Steps 1 and 2 for a request to `path` with `headers` (the request's own headers, without a
 * presence header): `{ body }` to send with the headers now set for step 3, or `{ res }`, the answer
 * to map as the request's own (a refusal of step 1, or `presence_required` when the gesture was
 * dismissed). A network failure throws, as the caller's own fetch does.
 */
export async function passkeyCeremony(
  doFetch: typeof fetch,
  path: string,
  headers: Headers,
  gesture: CeremonyGesture,
): Promise<{ readonly body: Uint8Array<ArrayBuffer> } | { readonly res: Response }> {
  const ask = new Headers(headers);
  ask.set(PRESENCE_HEADER, 'challenge');
  ask.delete(CEREMONY_HEADER);
  const res = await doFetch(path, {
    method: 'POST',
    headers: ask,
    body: new Uint8Array(0),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status !== 200) return { res };
  let answer: Record<string, unknown>;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed !== 'object' || parsed === null) return { res: presenceRequired() };
    answer = parsed as Record<string, unknown>;
  } catch {
    return { res: presenceRequired() };
  }
  const ceremony = answer['ceremony'];
  const publicKey = ceremonyPublicKeyOf(answer['publicKey']);
  if (
    answer['status'] !== 'ready' ||
    typeof ceremony !== 'string' ||
    !CEREMONY.test(ceremony) ||
    publicKey === undefined
  ) {
    return { res: presenceRequired() };
  }
  const body = await gesture(publicKey);
  if (body === undefined || body.length === 0) return { res: presenceRequired() };
  headers.set(PRESENCE_HEADER, 'passkey');
  headers.set(CEREMONY_HEADER, ceremony);
  const copy = new Uint8Array(body);
  body.fill(0);
  return { body: copy };
}

/**
 * DESK051-C6: the ceremony of a native gesture for a request to `path` with `headers`: `{ body }`
 * (empty) to send with the headers now set (`native` and the ceremony ID), or `{ res }`, the answer
 * to map as the request's own (a refusal: a wait, an expired session, no native presence here).
 */
export async function nativeCeremony(
  doFetch: typeof fetch,
  path: string,
  headers: Headers,
): Promise<{ readonly body: Uint8Array<ArrayBuffer> } | { readonly res: Response }> {
  const ask = new Headers(headers);
  ask.set(PRESENCE_HEADER, 'native-challenge');
  ask.delete(CEREMONY_HEADER);
  const res = await doFetch(path, {
    method: 'POST',
    headers: ask,
    body: new Uint8Array(0),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status !== 200) return { res };
  let ceremony: unknown;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed !== 'object' || parsed === null) return { res: presenceRequired() };
    const answer = parsed as Record<string, unknown>;
    if (answer['status'] !== 'ready') return { res: presenceRequired() };
    ceremony = answer['ceremony'];
  } catch {
    return { res: presenceRequired() };
  }
  if (typeof ceremony !== 'string' || !CEREMONY.test(ceremony)) return { res: presenceRequired() };
  headers.set(PRESENCE_HEADER, 'native');
  headers.set(CEREMONY_HEADER, ceremony);
  return { body: new Uint8Array(0) };
}

/**
 * The proof a sheet hands over: the master code as typed, the passkey (its gesture runs here), or
 * native presence in the desktop app (DESK051-C6: the server runs the gesture for its ceremony).
 */
export type CeremonyPresenceProof =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'passkey'; readonly gesture: CeremonyGesture }
  | { readonly kind: 'native' };

/**
 * The body of a request with `proof`, its presence headers set on `headers`: the master code as
 * UTF-8, the passkey through its ceremony, or nothing after a native ceremony. `{ res }` is a
 * refusal to map as the request's own answer.
 */
export async function proofBody(
  doFetch: typeof fetch,
  path: string,
  headers: Headers,
  proof: CeremonyPresenceProof,
): Promise<{ readonly body: Uint8Array<ArrayBuffer> } | { readonly res: Response }> {
  if (proof.kind === 'passkey') return passkeyCeremony(doFetch, path, headers, proof.gesture);
  if (proof.kind === 'native') return nativeCeremony(doFetch, path, headers);
  const encoded = new TextEncoder().encode(proof.code);
  const body = Uint8Array.from(encoded);
  encoded.fill(0);
  return { body };
}

/**
 * One owner request to `path` with `headers` and `proof`: the master code as the UTF-8 body, the
 * passkey through its ceremony (steps 1 to 3 above), or native presence through its ceremony. The answer to map; a network failure throws.
 * The presence bytes are wiped once sent.
 */
export async function sendWithProof(
  doFetch: typeof fetch,
  path: string,
  headers: Headers,
  proof: CeremonyPresenceProof,
): Promise<Response> {
  const ready = await proofBody(doFetch, path, headers, proof);
  if ('res' in ready) return ready.res;
  const body = ready.body;
  try {
    return await doFetch(path, {
      method: 'POST',
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } finally {
    body.fill(0);
  }
}
